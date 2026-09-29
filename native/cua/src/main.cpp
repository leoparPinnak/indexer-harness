// cua-helper: the CodexNative computer-use helper.
//
// Standalone console process speaking newline-delimited JSON on stdio:
//   request  {"id": <number>, "method": <string>, "params": {...}, "meta": {...}}
//   response {"id": <number>, "ok": true, "result": {...}}
//            | {"id": <number>, "error": <string>}
//            | {"id": <number>, "approvalRequest": {"app": ..., ...}}
//
// Mechanism (mirrors Codex's codex-computer-use.exe):
//   - reads:  native COM UIA (uiautomationcore.dll, raw vtable calls)
//   - input:  SendInput synthesis on the real input desktop
//   - shots:  Windows.Graphics.Capture with a PrintWindow GDI fallback
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>

#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "capture.h"
#include "input.h"
#include "json.h"
#include "uia.h"
#include "util.h"

namespace {

using cua::Json;

struct CuaError : std::runtime_error {
  explicit CuaError(const std::string& message) : std::runtime_error(message) {}
};

// Raised when launch_app must pause for user approval (transport-level flow).
struct ApprovalRequired {
  Json payload;
};

std::string envOr(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  if (value == nullptr) return fallback;
  return std::string(value);
}

std::string processNameFor(HWND window) {
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0) return "unknown.exe";
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return "unknown.exe";
  wchar_t path[1024];
  DWORD length = 1024;
  std::string name = "unknown.exe";
  if (QueryFullProcessImageNameW(process, 0, path, &length)) {
    std::wstring full(path, length);
    size_t slash = full.find_last_of(L"\\/");
    std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
    name = cua::wideToUtf8(base);
  }
  CloseHandle(process);
  return name;
}

std::string titleFor(HWND window) {
  int length = GetWindowTextLengthW(window);
  if (length <= 0) return std::string();
  std::wstring buffer(static_cast<size_t>(length) + 1, L'\0');
  int copied = GetWindowTextW(window, buffer.data(), length + 1);
  if (copied <= 0) return std::string();
  buffer.resize(static_cast<size_t>(copied));
  return cua::wideToUtf8(buffer);
}

Json windowJson(HWND window) {
  Json out = Json::makeObject();
  out.set("app", Json::makeString(processNameFor(window)));
  out.set("id", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(window))));
  out.set("title", Json::makeString(titleFor(window)));
  return out;
}

HWND windowFromParams(const Json& params) {
  const Json* window = params.find("window");
  if (window == nullptr || !window->isObject()) throw CuaError("window is required: {app, id, title}");
  const Json* id = window->find("id");
  if (id == nullptr || !id->isNumber()) throw CuaError("window.id must be an integer handle");
  HWND hwnd = reinterpret_cast<HWND>(static_cast<LONG_PTR>(id->number));
  if (!IsWindow(hwnd)) throw CuaError("window.id is not a window of this desktop");
  return hwnd;
}

std::string requiredString(const Json& params, const char* key) {
  const Json* value = params.find(key);
  if (value == nullptr || !value->isString() || value->str.empty())
    throw CuaError(std::string(key) + " is required");
  return value->str;
}

double requiredNumber(const Json& params, const char* key) {
  const Json* value = params.find(key);
  if (value == nullptr || !value->isNumber()) throw CuaError(std::string(key) + " must be a finite number");
  return value->number;
}

std::string spaceParam(const Json& params) {
  const Json* value = params.find("space");
  if (value == nullptr) return "screen";
  if (!value->isString() || (value->str != "screen" && value->str != "window"))
    throw CuaError("space must be \"screen\" or \"window\"");
  return value->str;
}

struct EnumWindowsState {
  std::vector<HWND> windows;
  DWORD selfPid = 0;
};

BOOL CALLBACK collectWindows(HWND window, LPARAM parameter) {
  auto* state = reinterpret_cast<EnumWindowsState*>(parameter);
  if (!IsWindowVisible(window)) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0 || pid == state->selfPid) return TRUE;
  if (GetWindow(window, GW_OWNER) != nullptr) return TRUE;
  std::string title = titleFor(window);
  if (title.empty()) return TRUE;
  state->windows.push_back(window);
  return TRUE;
}

Json listWindowsResult() {
  EnumWindowsState state;
  state.selfPid = GetCurrentProcessId();
  EnumWindows(collectWindows, reinterpret_cast<LPARAM>(&state));
  Json out = Json::makeArray();
  for (HWND window : state.windows) out.push(windowJson(window));
  return out;
}

Json listAppsResult() {
  EnumWindowsState state;
  state.selfPid = GetCurrentProcessId();
  EnumWindows(collectWindows, reinterpret_cast<LPARAM>(&state));
  std::vector<std::string> order;
  std::vector<Json> apps;
  std::vector<std::vector<Json>> appWindows;
  for (HWND window : state.windows) {
    std::string app = processNameFor(window);
    size_t index = order.size();
    for (size_t i = 0; i < order.size(); ++i) {
      if (order[i] == app) index = i;
    }
    if (index == order.size()) {
      order.push_back(app);
      apps.push_back(Json());
      appWindows.push_back({});
    }
    appWindows[index].push_back(windowJson(window));
  }
  Json out = Json::makeArray();
  for (size_t i = 0; i < order.size(); ++i) {
    Json entry = Json::makeObject();
    entry.set("id", Json::makeString(order[i]));
    std::string display = order[i];
    size_t dot = display.rfind(".exe");
    if (dot != std::string::npos && dot + 4 == display.size()) display = display.substr(0, dot);
    entry.set("displayName", Json::makeString(display));
    entry.set("isRunning", Json::makeBool(true));
    Json windows = Json::makeArray();
    for (Json& window : appWindows[i]) windows.push(std::move(window));
    entry.set("windows", std::move(windows));
    out.push(std::move(entry));
  }
  return out;
}

int elementIndexParam(const Json& params) {
  const Json* value = params.find("element_index");
  if (value == nullptr || !value->isNumber()) throw CuaError("element_index must be an integer >= 0");
  return static_cast<int>(value->number);
}

Json getWindowStateResult(const Json& params) {
  HWND window = windowFromParams(params);
  bool includeScreenshot = params.getBool("include_screenshot", true);
  bool includeText = params.getBool("include_text", false);
  bool disableDiff = params.getBool("disableDiff", false);

  Json result = Json::makeObject();
  result.set("window", windowJson(window));

  Json screenshots = Json::makeArray();
  if (includeScreenshot) {
    std::vector<cua::FrameShot> shots;
    std::string usedMode;
    std::string error;
    if (!cua::captureScreenshotFrames(window, &shots, &usedMode, &error)) throw CuaError("screenshot capture failed: " + error);
    for (const cua::FrameShot& shot : shots) {
      Json entry = Json::makeObject();
      entry.set("id", Json::makeString(shot.id));
      entry.set("zIndex", Json::makeNumber(shot.zIndex));
      entry.set("url", Json::makeString(shot.dataUrl));
      entry.set("originX", Json::makeNumber(shot.originX));
      entry.set("originY", Json::makeNumber(shot.originY));
      entry.set("width", Json::makeNumber(shot.width));
      entry.set("height", Json::makeNumber(shot.height));
      screenshots.push(std::move(entry));
    }
    result.set("captureMode", Json::makeString(usedMode));
  }
  result.set("screenshots", std::move(screenshots));

  if (includeText) {
    std::string uiaError;
    if (!cua::initUia(&uiaError)) throw CuaError("UIA init failed: " + uiaError);
    Json accessibility = cua::buildAccessibility(window, true, disableDiff, &uiaError);
    if (accessibility.isNull()) throw CuaError("accessibility walk failed: " + uiaError);
    result.set("accessibility", std::move(accessibility));
  }
  return result;
}

Json launchAppResult(const Json& params, const Json& meta) {
  std::string app = requiredString(params, "app");
  const char* approvedKey = "x-oai-cua-approved-app";
  bool requireApproval = envOr("CUA_REQUIRE_LAUNCH_APPROVAL", "0") == "1";
  std::string approved = meta.getString(approvedKey);
  if (requireApproval && approved != app) {
    ApprovalRequired approval;
    Json payload = Json::makeObject();
    payload.set("app", Json::makeString(app));
    payload.set("displayName", Json::makeString(app));
    payload.set("riskLevel", Json::makeString(envOr("CUA_LAUNCH_RISK_LEVEL", "low")));
    approval.payload = std::move(payload);
    throw approval;
  }

  // "notepad.exe -x" style splitting: executable token + argument tail.
  std::string executable = app;
  std::string arguments;
  size_t space = app.find(' ');
  bool split = space != std::string::npos;
  if (split) {
    std::string head = app.substr(0, space);
    std::string lower = head;
    for (char& c : lower) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
    bool looksExecutable = lower.size() >= 4 &&
                           (lower.rfind(".exe") == lower.size() - 4 || lower.rfind(".com") == lower.size() - 4 ||
                            lower.rfind(".bat") == lower.size() - 4 || lower.rfind(".cmd") == lower.size() - 4);
    if (looksExecutable) {
      executable = head;
      arguments = app.substr(space + 1);
    }
  }
  HINSTANCE launched = ShellExecuteW(nullptr, L"open", cua::utf8ToWide(executable).c_str(),
                                     arguments.empty() ? nullptr : cua::utf8ToWide(arguments).c_str(), nullptr,
                                     SW_SHOWNORMAL);
  INT_PTR code = reinterpret_cast<INT_PTR>(launched);
  if (code <= 32) throw CuaError("launch_app failed for " + app + " with ShellExecute code " + std::to_string(code));
  Json result = Json::makeObject();
  result.set("app", Json::makeString(app));
  result.set("launched", Json::makeBool(true));
  return result;
}

Json dispatch(const std::string& method, const Json& params, const Json& meta) {
  if (method == "get_window_state") return getWindowStateResult(params);

  if (method == "list_windows") return listWindowsResult();

  if (method == "list_apps") return listAppsResult();

  if (method == "get_window") {
    HWND window = windowFromParams(params);
    return windowJson(window);
  }

  if (method == "activate_window") {
    HWND window = windowFromParams(params);
    return cua::outcomeJson(cua::activateTarget(window));
  }

  if (method == "move") {
    HWND window = windowFromParams(params);
    double x = requiredNumber(params, "x");
    double y = requiredNumber(params, "y");
    return cua::outcomeJson(cua::moveTo(window, x, y, spaceParam(params)));
  }

  if (method == "click") {
    HWND window = windowFromParams(params);
    double x = requiredNumber(params, "x");
    double y = requiredNumber(params, "y");
    const Json* countValue = params.find("click_count");
    int clickCount = countValue != nullptr && countValue->isNumber() ? static_cast<int>(countValue->number) : 1;
    std::string button = params.getString("mouse_button", "left");
    if (button != "left" && button != "right" && button != "middle") throw CuaError("mouse_button must be left, right, or middle");
    return cua::outcomeJson(cua::clickAt(window, x, y, spaceParam(params), button, clickCount));
  }

  if (method == "click_element") {
    HWND window = windowFromParams(params);
    int index = elementIndexParam(params);
    auto element = cua::snapshotElement(window, index, nullptr);
    if (element == nullptr) {
      std::string error;
      cua::snapshotElement(window, index, &error);
      throw CuaError(error);
    }
    RECT bounds{};
    if (FAILED(element->get_CurrentBoundingRectangle(&bounds)) || (bounds.right <= bounds.left) ||
        (bounds.bottom <= bounds.top)) {
      throw CuaError("element_index " + std::to_string(index) + " has no clickable bounds");
    }
    double x = (bounds.left + bounds.right) / 2.0;
    double y = (bounds.top + bounds.bottom) / 2.0;
    const Json* countValue = params.find("click_count");
    int clickCount = countValue != nullptr && countValue->isNumber() ? static_cast<int>(countValue->number) : 1;
    std::string button = params.getString("mouse_button", "left");
    if (button != "left" && button != "right" && button != "middle") throw CuaError("mouse_button must be left, right, or middle");
    return cua::outcomeJson(cua::clickAt(window, x, y, "screen", button, clickCount));
  }

  if (method == "scroll") {
    HWND window = windowFromParams(params);
    double x = requiredNumber(params, "x");
    double y = requiredNumber(params, "y");
    double scrollX = params.getNumber("scrollX", 0);
    double scrollY = params.getNumber("scrollY", 0);
    return cua::outcomeJson(cua::scrollAt(window, x, y, spaceParam(params), scrollX, scrollY));
  }

  if (method == "drag") {
    HWND window = windowFromParams(params);
    double fromX = requiredNumber(params, "from_x");
    double fromY = requiredNumber(params, "from_y");
    double toX = requiredNumber(params, "to_x");
    double toY = requiredNumber(params, "to_y");
    return cua::outcomeJson(cua::dragTo(window, fromX, fromY, toX, toY, spaceParam(params)));
  }

  if (method == "press_key") {
    HWND window = windowFromParams(params);
    std::string key = requiredString(params, "key");
    return cua::outcomeJson(cua::pressCombo(window, key));
  }

  if (method == "type_text") {
    HWND window = windowFromParams(params);
    std::string text = requiredString(params, "text");
    return cua::outcomeJson(cua::typeText(window, text));
  }

  if (method == "perform_secondary_action") {
    HWND window = windowFromParams(params);
    int index = elementIndexParam(params);
    std::string action = requiredString(params, "action");
    std::string error;
    Json result = cua::performSecondaryAction(window, index, action, &error);
    if (result.isNull()) throw CuaError(error);
    return result;
  }

  if (method == "set_value") {
    HWND window = windowFromParams(params);
    int index = elementIndexParam(params);
    std::string value = requiredString(params, "value");
    std::string error;
    Json result = cua::setElementValue(window, index, value, &error);
    if (result.isNull()) throw CuaError(error);
    return result;
  }

  if (method == "capture") {
    HWND window = windowFromParams(params);
    const Json* samplesValue = params.find("samples");
    if (samplesValue != nullptr && !samplesValue->isArray()) throw CuaError("samples must be an array");
    std::vector<cua::RegionSample> samples;
    if (samplesValue != nullptr) {
      for (const Json& entry : samplesValue->arr) {
        if (!entry.isObject()) throw CuaError("each sample must be {name, space, x, y}");
        cua::RegionSample sample;
        sample.name = entry.getString("name");
        if (sample.name.empty()) throw CuaError("each sample needs a name");
        std::string space = entry.getString("space", "window");
        if (space != "window" && space != "desktop") throw CuaError("sample space must be window or desktop");
        sample.windowSpace = space == "window";
        const Json* x = entry.find("x");
        const Json* y = entry.find("y");
        if (x == nullptr || !x->isNumber() || y == nullptr || !y->isNumber())
          throw CuaError("each sample needs numeric x and y");
        sample.x = x->number;
        sample.y = y->number;
        samples.push_back(sample);
      }
    }
    cua::CaptureResult result;
    std::string error;
    if (!cua::captureRegions(window, samples, params.getString("mode"), &result, &error))
      throw CuaError("capture failed: " + error);
    Json out = Json::makeObject();
    out.set("width", Json::makeNumber(result.width));
    out.set("height", Json::makeNumber(result.height));
    out.set("mode", Json::makeString(result.mode));
    if (!result.fallbackReason.empty()) out.set("fallbackReason", Json::makeString(result.fallbackReason));
    if (!result.desktopSource.empty()) out.set("desktopSource", Json::makeString(result.desktopSource));
    out.set("regions", std::move(result.regions));
    return out;
  }

  if (method == "launch_app") return launchAppResult(params, meta);

  if (method == "end_turn") {
    cua::clearUiaCaches();
    Json result = Json::makeObject();
    result.set("endTurn", Json::makeBool(true));
    return result;
  }

  if (method == "get_helper_info") {
    std::string desktopName = "unknown";
    HDESK desk = GetThreadDesktop(GetCurrentThreadId());
    if (desk != nullptr) {
      char buffer[256];
      DWORD needed = 0;
      if (GetUserObjectInformationA(desk, UOI_NAME, buffer, sizeof(buffer), &needed) && needed <= sizeof(buffer)) {
        desktopName.assign(buffer);
      }
    }
    Json result = Json::makeObject();
    result.set("helper", Json::makeString("cua-helper"));
    result.set("desktop", Json::makeString(desktopName));
    result.set("pid", Json::makeNumber(static_cast<double>(GetCurrentProcessId())));
    result.set("elevated", Json::makeBool(cua::injectorElevated()));
    result.set("comApartment", Json::makeString("multi-threaded"));
    POINT cursor{};
    if (GetCursorPos(&cursor)) {
      Json cursorJson = Json::makeObject();
      cursorJson.set("x", Json::makeNumber(cursor.x));
      cursorJson.set("y", Json::makeNumber(cursor.y));
      result.set("cursor", std::move(cursorJson));
    }
    // Stuck-modifier detector: a held Ctrl/Shift/Alt swallows character input.
    Json keys = Json::makeObject();
    keys.set("ctrl", Json::makeBool((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0));
    keys.set("shift", Json::makeBool((GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0));
    keys.set("alt", Json::makeBool((GetAsyncKeyState(VK_MENU) & 0x8000) != 0));
    keys.set("lwin", Json::makeBool((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0));
    result.set("asyncKeys", std::move(keys));
    return result;
  }

  if (method == "probe_capture") {
    const Json* windowParam = params.find("window");
    HWND window = windowParam != nullptr ? windowFromParams(params) : nullptr;
    return cua::captureProbeResult(window);
  }

  if (method == "probe_window") {
    HWND window = windowFromParams(params);
    Json out = Json::makeObject();
    out.set("visible", Json::makeBool(IsWindowVisible(window) != FALSE));
    out.set("iconic", Json::makeBool(IsIconic(window) != FALSE));
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) {
      out.set("cloaked", Json::makeNumber(static_cast<double>(cloaked)));
    }
    RECT rect{};
    if (GetWindowRect(window, &rect)) {
      Json rectJson = Json::makeObject();
      rectJson.set("left", Json::makeNumber(rect.left));
      rectJson.set("top", Json::makeNumber(rect.top));
      rectJson.set("right", Json::makeNumber(rect.right));
      rectJson.set("bottom", Json::makeNumber(rect.bottom));
      out.set("rect", std::move(rectJson));
    }
    HWND foreground = GetForegroundWindow();
    out.set("foreground", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(foreground))));
    out.set("isForeground", Json::makeBool(foreground == window));
    GUITHREADINFO info{};
    info.cbSize = sizeof(info);
    DWORD foregroundThread = foreground != nullptr ? GetWindowThreadProcessId(foreground, nullptr) : 0;
    if (foregroundThread != 0 && GetGUIThreadInfo(foregroundThread, &info)) {
      out.set("guiActive", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(info.hwndActive))));
      out.set("guiFocus", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(info.hwndFocus))));
      out.set("guiCapture", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(info.hwndCapture))));
    }
    // Windows stacked above the target (z-order walk toward the top).
    Json above = Json::makeArray();
    HWND cursor = window;
    for (int step = 0; step < 12; step += 1) {
      cursor = GetWindow(cursor, GW_HWNDPREV);
      if (cursor == nullptr) break;
      if (!IsWindowVisible(cursor)) continue;
      Json entry = Json::makeObject();
      entry.set("hwnd", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(cursor))));
      entry.set("title", Json::makeString(titleFor(cursor)));
      entry.set("app", Json::makeString(processNameFor(cursor)));
      RECT aboveRect{};
      if (GetWindowRect(cursor, &aboveRect)) {
        entry.set("left", Json::makeNumber(aboveRect.left));
        entry.set("top", Json::makeNumber(aboveRect.top));
        entry.set("right", Json::makeNumber(aboveRect.right));
        entry.set("bottom", Json::makeNumber(aboveRect.bottom));
      }
      above.push(std::move(entry));
    }
    out.set("zAboveCount", Json::makeNumber(static_cast<double>(above.arr.size())));
    out.set("zAbove", std::move(above));
    if (foreground != nullptr) {
      out.set("foregroundTitle", Json::makeString(titleFor(foreground)));
      out.set("foregroundApp", Json::makeString(processNameFor(foreground)));
      RECT fgRect{};
      if (GetWindowRect(foreground, &fgRect)) {
        out.set("foregroundLeft", Json::makeNumber(fgRect.left));
        out.set("foregroundTop", Json::makeNumber(fgRect.top));
        out.set("foregroundRight", Json::makeNumber(fgRect.right));
        out.set("foregroundBottom", Json::makeNumber(fgRect.bottom));
      }
    }
    return out;
  }

  if (method == "close") {
    Json result = Json::makeObject();
    result.set("closing", Json::makeBool(true));
    return result;
  }

  throw CuaError("unknown method: " + method);
}

}  // namespace

int main() {
  // Per-monitor-v2 pixel truth: window rects and SendInput coordinates stay in
  // real pixels regardless of DPI virtualization.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Opt-in private desktop (measurement harness only): join/create a named
  // desktop BEFORE any COM/window work so this thread runs off the input
  // desktop. Used by the gated suite to measure the cross-desktop focus wall.
  const char* privateDesktop = std::getenv("CUA_PRIVATE_DESKTOP");
  if (privateDesktop != nullptr && privateDesktop[0] != '\0') {
    std::wstring name = cua::utf8ToWide(privateDesktop);
    HDESK desk = OpenDesktopW(name.c_str(), 0, FALSE, DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS |
                                                          DESKTOP_SWITCHDESKTOP | DESKTOP_CREATEWINDOW);
    DWORD openError = desk == nullptr ? GetLastError() : 0;
    if (desk == nullptr) {
      // dwAccess must be a real rights mask: 0 fails with ERROR_NOT_ENOUGH_MEMORY (8).
      desk = CreateDesktopW(name.c_str(), nullptr, nullptr, 0, MAXIMUM_ALLOWED, nullptr);
      if (desk == nullptr) {
        std::fprintf(stderr, "cua-helper: OpenDesktopW failed (%lu) and CreateDesktopW failed (%lu) for %s\n",
                     static_cast<unsigned long>(openError), static_cast<unsigned long>(GetLastError()),
                     privateDesktop);
      }
    }
    if (desk != nullptr && !SetThreadDesktop(desk)) {
      std::fprintf(stderr, "cua-helper: SetThreadDesktop(%s) failed: %lu\n", privateDesktop,
                   static_cast<unsigned long>(GetLastError()));
    }
  }

  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool comReady = SUCCEEDED(apartment) || apartment == RPC_E_CHANGED_MODE;
  if (!comReady) {
    std::fprintf(stderr, "cua-helper: CoInitializeEx failed hr=%s\n", cua::hexHr(apartment).c_str());
    return 1;
  }

  bool shutdown = false;
  std::string line;
  while (!shutdown && std::getline(std::cin, line)) {
    line = cua::trim(line);
    if (line.empty()) continue;

    std::string parseError;
    Json request = Json::parse(line, &parseError);
    if (!parseError.empty()) {
      std::fprintf(stderr, "cua-helper: invalid request JSON: %s\n", parseError.c_str());
      continue;
    }
    const Json* idValue = request.find("id");
    if (idValue == nullptr || !idValue->isNumber()) {
      std::fprintf(stderr, "cua-helper: request has no numeric id\n");
      continue;
    }
    double id = idValue->number;
    const Json* methodValue = request.find("method");
    Json response = Json::makeObject();
    response.set("id", Json::makeNumber(id));
    if (methodValue == nullptr || !methodValue->isString() || methodValue->str.empty()) {
      response.set("error", Json::makeString("method is required"));
    } else {
      const Json* paramsValue = request.find("params");
      Json params = (paramsValue != nullptr && paramsValue->isObject()) ? *paramsValue : Json::makeObject();
      const Json* metaValue = request.find("meta");
      Json meta = (metaValue != nullptr && metaValue->isObject()) ? *metaValue : Json::makeObject();
      try {
        Json result = dispatch(methodValue->str, params, meta);
        response.set("ok", Json::makeBool(true));
        response.set("result", std::move(result));
        if (methodValue->str == "close") shutdown = true;
      } catch (const ApprovalRequired& approval) {
        response.set("approvalRequest", std::move(approval.payload));
      } catch (const std::exception& error) {
        response.set("error", Json::makeString(error.what()));
      }
    }

    std::string payload = response.dump();
    payload.push_back('\n');
    size_t written = fwrite(payload.data(), 1, payload.size(), stdout);
    fflush(stdout);
    if (written != payload.size()) break;
  }
  return 0;
}

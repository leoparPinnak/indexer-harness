#include "input.h"

#include <cmath>
#include <cstdlib>
#include <vector>

#include "util.h"

namespace cua {
namespace {

bool computeSelfElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD returned = 0;
  BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &returned);
  CloseHandle(token);
  return ok != FALSE && elevation.TokenIsElevated != 0;
}

// 1 = elevated target, 0 = standard target, -1 = unknown (query failed).
int targetElevation(HWND target) {
  DWORD pid = 0;
  GetWindowThreadProcessId(target, &pid);
  if (pid == 0) return -1;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return -1;
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
    CloseHandle(process);
    return -1;
  }
  TOKEN_ELEVATION elevation{};
  DWORD returned = 0;
  BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &returned);
  CloseHandle(token);
  CloseHandle(process);
  if (!ok) return -1;
  return elevation.TokenIsElevated != 0 ? 1 : 0;
}

std::string elevationNote(HWND target) {
  int state = targetElevation(target);
  if (state == 1) {
    return injectorElevated() ? "target elevated; injector elevated (UIPI allows delivery)"
                              : "target elevated; injector not elevated (UIPI drops window-bound input)";
  }
  if (state == 0) return "target standard integrity";
  return "target elevation unknown";
}

bool uiPiBlocks(HWND target) { return targetElevation(target) == 1 && !injectorElevated(); }

void finish(InputOutcome* outcome) {
  outcome->foreground = GetForegroundWindow();
  outcome->focusTransferred = outcome->target != nullptr && outcome->foreground == outcome->target;
}

bool absoluteCoords(const POINT& point, LONG* nx, LONG* ny) {
  int originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width <= 1 || height <= 1) return false;
  *nx = MulDiv(point.x - originX, 65535, width - 1);
  *ny = MulDiv(point.y - originY, 65535, height - 1);
  return true;
}

INPUT mouseInput(DWORD flags, LONG dx = 0, LONG dy = 0, DWORD data = 0) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = dx;
  input.mi.dy = dy;
  input.mi.mouseData = data;
  input.mi.dwFlags = flags;
  return input;
}

INPUT keyInput(WORD virtualKey, DWORD flags, WORD scanCode = 0) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = virtualKey;
  input.ki.wScan = scanCode;
  input.ki.dwFlags = flags;
  return input;
}

UINT sendAll(const std::vector<INPUT>& events) {
  if (events.empty()) return 0;
  return SendInput(static_cast<UINT>(events.size()), const_cast<INPUT*>(events.data()), sizeof(INPUT));
}

std::string countDetail(const char* mechanism, UINT sent, UINT expected) {
  return std::string(mechanism) + ": " + std::to_string(sent) + "/" + std::to_string(expected) +
         " events queued on the input queue";
}

bool cursorAt(const POINT& expected, POINT* actual) {
  if (!GetCursorPos(actual)) return false;
  return std::abs(actual->x - expected.x) <= 2 && std::abs(actual->y - expected.y) <= 2;
}

bool nameEquals(const std::string& token, const char* lowerName) {
  if (token.size() != strlen(lowerName)) return false;
  for (size_t i = 0; i < token.size(); ++i) {
    char c = token[i];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != lowerName[i]) return false;
  }
  return true;
}

// Map one combo token to a virtual key. Returns 0 when unparseable.
WORD tokenToKey(const std::string& token, bool* needsShift, bool* isModifier, DWORD* modifierVk) {
  *needsShift = false;
  *isModifier = false;
  *modifierVk = 0;
  if (token.empty()) return 0;

  if (nameEquals(token, "ctrl") || nameEquals(token, "control")) { *isModifier = true; *modifierVk = VK_CONTROL; return VK_CONTROL; }
  if (nameEquals(token, "alt")) { *isModifier = true; *modifierVk = VK_MENU; return VK_MENU; }
  if (nameEquals(token, "shift")) { *isModifier = true; *modifierVk = VK_SHIFT; return VK_SHIFT; }
  if (nameEquals(token, "win") || nameEquals(token, "windows")) { *isModifier = true; *modifierVk = VK_LWIN; return VK_LWIN; }

  struct NamedKey { const char* name; WORD vk; };
  static const NamedKey kNamed[] = {
      {"enter", VK_RETURN},    {"return", VK_RETURN}, {"esc", VK_ESCAPE},     {"escape", VK_ESCAPE},
      {"tab", VK_TAB},         {"space", VK_SPACE},   {"backspace", VK_BACK}, {"back", VK_BACK},
      {"delete", VK_DELETE},   {"del", VK_DELETE},    {"insert", VK_INSERT},  {"ins", VK_INSERT},
      {"home", VK_HOME},       {"end", VK_END},       {"pageup", VK_PRIOR},   {"prior", VK_PRIOR},
      {"pagedown", VK_NEXT},   {"next", VK_NEXT},     {"up", VK_UP},          {"down", VK_DOWN},
      {"left", VK_LEFT},       {"right", VK_RIGHT},   {"capslock", VK_CAPITAL}, {"pause", VK_PAUSE},
      {"printscreen", VK_SNAPSHOT}, {"scrolllock", VK_SCROLL},
  };
  for (const NamedKey& entry : kNamed) {
    if (nameEquals(token, entry.name)) return entry.vk;
  }

  // F1..F12
  if ((token[0] == 'f' || token[0] == 'F') && token.size() >= 2 && token.size() <= 3) {
    int number = atoi(token.c_str() + 1);
    if (number >= 1 && number <= 12 && std::string(token.c_str() + 1) == std::to_string(number)) {
      return static_cast<WORD>(VK_F1 + (number - 1));
    }
  }

  // Single character: layout-aware translation through VkKeyScanW.
  std::wstring wide = utf8ToWide(token);
  if (wide.size() == 1) {
    SHORT translated = VkKeyScanW(wide[0]);
    if (translated == -1) return 0;
    WORD vk = static_cast<WORD>(translated & 0xff);
    BYTE shiftState = static_cast<BYTE>((translated >> 8) & 0xff);
    if ((shiftState & 1) != 0) *needsShift = true;
    return vk;
  }
  return 0;
}

}  // namespace

bool injectorElevated() {
  static const bool elevated = computeSelfElevated();
  return elevated;
}

bool awaitForeground(HWND target, DWORD timeoutMs) {
  const DWORD stepMs = 10;
  for (DWORD waited = 0; waited <= timeoutMs; waited += stepMs) {
    if (GetForegroundWindow() == target) return true;
    Sleep(stepMs);
  }
  return GetForegroundWindow() == target;
}

bool inputSpacePoint(HWND target, const std::string& space, double x, double y, POINT* out, std::string* errorOut) {
  LONG px = static_cast<LONG>(std::llround(x));
  LONG py = static_cast<LONG>(std::llround(y));
  if (space == "window") {
    RECT rect{};
    if (target == nullptr || !GetWindowRect(target, &rect)) {
      if (errorOut != nullptr) *errorOut = "window-space coordinates need a valid target window";
      return false;
    }
    px += rect.left;
    py += rect.top;
  }
  out->x = px;
  out->y = py;
  return true;
}

InputOutcome moveTo(HWND target, double x, double y, const std::string& space) {
  InputOutcome outcome;
  outcome.target = target;
  POINT point{};
  std::string error;
  if (!inputSpacePoint(target, space, x, y, &point, &error)) {
    outcome.detail = error;
    finish(&outcome);
    return outcome;
  }
  LONG nx = 0;
  LONG ny = 0;
  if (!absoluteCoords(point, &nx, &ny)) {
    outcome.detail = "virtual-screen metrics unavailable";
    finish(&outcome);
    return outcome;
  }
  std::vector<INPUT> events{mouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny)};
  UINT sent = sendAll(events);
  POINT after{};
  bool landed = sent == 1 && cursorAt(point, &after);
  outcome.delivered = landed;
  outcome.detail = countDetail("SendInput move", sent, 1) + "; cursor at " + std::to_string(after.x) + "," +
                   std::to_string(after.y) + " (requested " + std::to_string(point.x) + "," + std::to_string(point.y) + ")";
  finish(&outcome);
  return outcome;
}

InputOutcome clickAt(HWND target, double x, double y, const std::string& space, const std::string& button, int clickCount) {
  InputOutcome outcome;
  outcome.target = target;

  InputOutcome move = moveTo(target, x, y, space);
  if (!move.delivered) {
    outcome.detail = "click aborted before button events: " + move.detail;
    finish(&outcome);
    return outcome;
  }

  DWORD downFlag = MOUSEEVENTF_LEFTDOWN;
  DWORD upFlag = MOUSEEVENTF_LEFTUP;
  const char* buttonName = "left";
  if (button == "right") {
    downFlag = MOUSEEVENTF_RIGHTDOWN;
    upFlag = MOUSEEVENTF_RIGHTUP;
    buttonName = "right";
  } else if (button == "middle") {
    downFlag = MOUSEEVENTF_MIDDLEDOWN;
    upFlag = MOUSEEVENTF_MIDDLEUP;
    buttonName = "middle";
  }

  if (clickCount < 1) clickCount = 1;
  std::vector<INPUT> events;
  for (int i = 0; i < clickCount; ++i) {
    events.push_back(mouseInput(downFlag));
    events.push_back(mouseInput(upFlag));
  }
  UINT sent = sendAll(events);
  UINT expected = static_cast<UINT>(clickCount * 2);
  bool blocked = uiPiBlocks(target);
  if (!blocked) awaitForeground(target, 250);
  outcome.delivered = sent == expected && !blocked;
  outcome.detail = countDetail("SendInput click", sent, expected) + "; " + buttonName + " x" + std::to_string(clickCount) +
                   "; " + elevationNote(target) + (blocked ? "; delivery blocked" : "");
  finish(&outcome);
  return outcome;
}

InputOutcome scrollAt(HWND target, double x, double y, const std::string& space, double deltaX, double deltaY) {
  InputOutcome outcome;
  outcome.target = target;
  if (deltaX == 0 && deltaY == 0) {
    outcome.detail = "scroll requires a non-zero scrollX or scrollY delta";
    finish(&outcome);
    return outcome;
  }
  InputOutcome move = moveTo(target, x, y, space);
  if (!move.delivered) {
    outcome.detail = "scroll aborted before wheel events: " + move.detail;
    finish(&outcome);
    return outcome;
  }
  std::vector<INPUT> events;
  if (deltaY != 0) {
    LONG wheel = static_cast<LONG>(std::llround(deltaY));
    if (wheel == 0) wheel = deltaY > 0 ? 1 : -1;
    events.push_back(mouseInput(MOUSEEVENTF_WHEEL, 0, 0, static_cast<DWORD>(wheel)));
  }
  if (deltaX != 0) {
    LONG wheel = static_cast<LONG>(std::llround(deltaX));
    if (wheel == 0) wheel = deltaX > 0 ? 1 : -1;
    events.push_back(mouseInput(MOUSEEVENTF_HWHEEL, 0, 0, static_cast<DWORD>(wheel)));
  }
  UINT sent = sendAll(events);
  bool blocked = uiPiBlocks(target);
  outcome.delivered = sent == events.size() && !blocked;
  outcome.detail = countDetail("SendInput wheel", sent, static_cast<UINT>(events.size())) + "; deltaY=" +
                   std::to_string(static_cast<long>(deltaY)) + "; " + elevationNote(target) +
                   (blocked ? "; delivery blocked" : "");
  finish(&outcome);
  return outcome;
}

InputOutcome dragTo(HWND target, double fromX, double fromY, double toX, double toY, const std::string& space) {
  InputOutcome outcome;
  outcome.target = target;
  InputOutcome move = moveTo(target, fromX, fromY, space);
  if (!move.delivered) {
    outcome.detail = "drag aborted before button events: " + move.detail;
    finish(&outcome);
    return outcome;
  }
  POINT start{};
  POINT end{};
  std::string error;
  if (!inputSpacePoint(target, space, fromX, fromY, &start, &error) || !inputSpacePoint(target, space, toX, toY, &end, &error)) {
    outcome.detail = error;
    finish(&outcome);
    return outcome;
  }

  std::vector<INPUT> events;
  events.push_back(mouseInput(MOUSEEVENTF_LEFTDOWN));
  double dx = static_cast<double>(end.x - start.x);
  double dy = static_cast<double>(end.y - start.y);
  double distance = std::sqrt(dx * dx + dy * dy);
  int steps = static_cast<int>(distance / 24.0);
  if (steps < 1) steps = 1;
  for (int i = 1; i <= steps; ++i) {
    LONG px = start.x + static_cast<LONG>(std::lround(dx * i / steps));
    LONG py = start.y + static_cast<LONG>(std::lround(dy * i / steps));
    LONG nx = 0;
    LONG ny = 0;
    if (absoluteCoords({px, py}, &nx, &ny)) {
      events.push_back(mouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny));
    }
  }
  events.push_back(mouseInput(MOUSEEVENTF_LEFTUP));
  UINT sent = sendAll(events);
  POINT landed{};
  bool ok = sent == events.size() && cursorAt(end, &landed);
  bool blocked = uiPiBlocks(target);
  outcome.delivered = ok && !blocked;
  outcome.detail = countDetail("SendInput drag", sent, static_cast<UINT>(events.size())) + "; cursor at " +
                   std::to_string(landed.x) + "," + std::to_string(landed.y) + "; " + elevationNote(target) +
                   (blocked ? "; delivery blocked" : "");
  finish(&outcome);
  return outcome;
}

InputOutcome activateTarget(HWND target) {
  InputOutcome outcome;
  outcome.target = target;
  if (target == nullptr || !IsWindow(target)) {
    outcome.detail = "activate failed: not a valid window";
    finish(&outcome);
    return outcome;
  }
  if (IsIconic(target)) ShowWindow(target, SW_RESTORE);

  HWND foreground = GetForegroundWindow();
  DWORD currentThread = GetCurrentThreadId();
  DWORD foregroundThread = foreground != nullptr ? GetWindowThreadProcessId(foreground, nullptr) : 0;
  bool attached = false;
  if (foregroundThread != 0 && foregroundThread != currentThread) {
    attached = AttachThreadInput(currentThread, foregroundThread, TRUE) != FALSE;
  }
  SetForegroundWindow(target);
  BringWindowToTop(target);
  if (attached) AttachThreadInput(currentThread, foregroundThread, FALSE);

  awaitForeground(target, 150);
  outcome.delivered = GetForegroundWindow() == target;
  outcome.detail = std::string(outcome.delivered
                                   ? "SetForegroundWindow landed on the interactive desktop"
                                   : "foreground did not transfer to the target (activation boundary)") +
                   "; " + elevationNote(target);
  finish(&outcome);
  return outcome;
}

InputOutcome pressCombo(HWND target, const std::string& key) {
  InputOutcome outcome;
  outcome.target = target;
  if (key.empty()) {
    outcome.detail = "key is required";
    finish(&outcome);
    return outcome;
  }

  InputOutcome activation = activateTarget(target);
  if (!activation.delivered) {
    outcome.detail = "key aborted before injection: " + activation.detail;
    finish(&outcome);
    return outcome;
  }

  // Split "ctrl+shift+t" on '+'.
  std::vector<std::string> tokens;
  std::string current;
  for (char c : key) {
    if (c == '+') {
      if (!current.empty()) tokens.push_back(current);
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  if (!current.empty()) tokens.push_back(current);
  if (tokens.empty()) {
    outcome.detail = "key is required";
    finish(&outcome);
    return outcome;
  }

  std::vector<INPUT> events;
  std::vector<WORD> modifiers;
  bool trailingShift = false;
  WORD mainKey = 0;
  for (const std::string& token : tokens) {
    bool needsShift = false;
    bool isModifier = false;
    DWORD modifierVk = 0;
    WORD vk = tokenToKey(token, &needsShift, &isModifier, &modifierVk);
    if (vk == 0) {
      outcome.detail = "unknown key token in " + key;
      finish(&outcome);
      return outcome;
    }
    if (isModifier) {
      bool seen = false;
      for (WORD existing : modifiers) {
        if (existing == modifierVk) seen = true;
      }
      if (!seen) modifiers.push_back(static_cast<WORD>(modifierVk));
      continue;
    }
    if (needsShift) trailingShift = true;
    mainKey = vk;
  }
  if (mainKey == 0) {
    outcome.detail = "key " + key + " has no primary key (modifiers only)";
    finish(&outcome);
    return outcome;
  }
  if (trailingShift) {
    bool seen = false;
    for (WORD existing : modifiers) {
      if (existing == VK_SHIFT) seen = true;
    }
    if (!seen) modifiers.push_back(VK_SHIFT);
  }

  for (WORD modifier : modifiers) events.push_back(keyInput(modifier, 0));
  events.push_back(keyInput(mainKey, 0));
  events.push_back(keyInput(mainKey, KEYEVENTF_KEYUP));
  for (auto it = modifiers.rbegin(); it != modifiers.rend(); ++it) events.push_back(keyInput(*it, KEYEVENTF_KEYUP));

  UINT sent = sendAll(events);
  bool blocked = uiPiBlocks(target);
  outcome.delivered = sent == events.size() && !blocked;
  outcome.detail = countDetail("SendInput key", sent, static_cast<UINT>(events.size())) + "; key '" + key +
                   "'; focus transferred to target; " + elevationNote(target) + (blocked ? "; delivery blocked" : "");
  finish(&outcome);
  return outcome;
}

InputOutcome typeText(HWND target, const std::string& text) {
  InputOutcome outcome;
  outcome.target = target;
  if (text.empty()) {
    outcome.detail = "text is required";
    finish(&outcome);
    return outcome;
  }

  InputOutcome activation = activateTarget(target);
  if (!activation.delivered) {
    outcome.detail = "type aborted before injection: " + activation.detail;
    finish(&outcome);
    return outcome;
  }

  std::wstring wide = utf8ToWide(text);
  std::vector<INPUT> events;
  events.reserve(wide.size() * 2);
  for (wchar_t unit : wide) {
    events.push_back(keyInput(0, KEYEVENTF_UNICODE, static_cast<WORD>(unit)));
    events.push_back(keyInput(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, static_cast<WORD>(unit)));
  }
  UINT sent = sendAll(events);
  UINT expected = static_cast<UINT>(wide.size() * 2);
  bool blocked = uiPiBlocks(target);
  outcome.delivered = sent == expected && !blocked;
  outcome.detail = countDetail("SendInput text", sent, expected) + "; " + std::to_string(wide.size()) +
                   " UTF-16 units; focus transferred to target; " + elevationNote(target) +
                   (blocked ? "; delivery blocked" : "");
  finish(&outcome);
  return outcome;
}

Json outcomeJson(const InputOutcome& outcome) {
  Json result = Json::makeObject();
  result.set("delivered", Json::makeBool(outcome.delivered));
  result.set("detail", Json::makeString(outcome.detail));
  result.set("target", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(outcome.target))));
  result.set("foreground", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(outcome.foreground))));
  result.set("focusTransferred", Json::makeBool(outcome.focusTransferred));
  return result;
}

}  // namespace cua

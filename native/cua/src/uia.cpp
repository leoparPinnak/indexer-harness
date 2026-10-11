#include "uia.h"

#include <algorithm>
#include <cctype>
#include <cstdio>

#include "input.h"
#include "util.h"

namespace cua {
namespace {

Microsoft::WRL::ComPtr<IUIAutomation> g_uia;
Microsoft::WRL::ComPtr<IUIAutomationTreeWalker> g_walker;
std::map<HWND, WindowSnapshot> g_snapshots;

// CLSID_CUIAutomation resolves from uiautomationcore.lib (already linked): the
// system COM server for IUIAutomation, no managed layer anywhere near it.

constexpr int kMaxDepth = 64;
constexpr size_t kMaxElements = 8000;

template <typename T>
Microsoft::WRL::ComPtr<T> patternAs(IUnknown* unknown) {
  Microsoft::WRL::ComPtr<T> out;
  if (unknown != nullptr) {
    unknown->QueryInterface(__uuidof(T), reinterpret_cast<void**>(out.GetAddressOf()));
  }
  return out;
}

std::string bstrToUtf8(BSTR value) {
  if (value == nullptr) return std::string();
  return wideToUtf8(value, static_cast<int>(SysStringLen(value)));
}

std::string controlTypeSegment(CONTROLTYPEID id) {
  switch (id) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_CalendarControlTypeId: return "calendar";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    case UIA_ComboBoxControlTypeId: return "combo";
    case UIA_EditControlTypeId: return "edit";
    case UIA_HyperlinkControlTypeId: return "hyperlink";
    case UIA_ImageControlTypeId: return "image";
    case UIA_ListItemControlTypeId: return "listitem";
    case UIA_ListControlTypeId: return "list";
    case UIA_MenuControlTypeId: return "menu";
    case UIA_MenuBarControlTypeId: return "menubar";
    case UIA_MenuItemControlTypeId: return "menuitem";
    case UIA_ProgressBarControlTypeId: return "progress";
    case UIA_RadioButtonControlTypeId: return "radio";
    case UIA_ScrollBarControlTypeId: return "scrollbar";
    case UIA_SliderControlTypeId: return "slider";
    case UIA_SpinnerControlTypeId: return "spinner";
    case UIA_StatusBarControlTypeId: return "statusbar";
    case UIA_TabControlTypeId: return "tab";
    case UIA_TabItemControlTypeId: return "tabitem";
    case UIA_TextControlTypeId: return "text";
    case UIA_ToolBarControlTypeId: return "toolbar";
    case UIA_ToolTipControlTypeId: return "tooltip";
    case UIA_TreeControlTypeId: return "tree";
    case UIA_TreeItemControlTypeId: return "treeitem";
    case UIA_CustomControlTypeId: return "custom";
    case UIA_GroupControlTypeId: return "group";
    case UIA_ThumbControlTypeId: return "thumb";
    case UIA_DataGridControlTypeId: return "datagrid";
    case UIA_DataItemControlTypeId: return "dataitem";
    case UIA_DocumentControlTypeId: return "document";
    case UIA_SplitButtonControlTypeId: return "splitbutton";
    case UIA_WindowControlTypeId: return "window";
    case UIA_PaneControlTypeId: return "pane";
    case UIA_HeaderControlTypeId: return "header";
    case UIA_HeaderItemControlTypeId: return "headeritem";
    case UIA_TableControlTypeId: return "table";
    case UIA_TitleBarControlTypeId: return "titlebar";
    case UIA_SeparatorControlTypeId: return "separator";
    case UIA_SemanticZoomControlTypeId: return "semanticzoom";
    case UIA_AppBarControlTypeId: return "appbar";
    default: return "element";
  }
}

std::string slug(const std::string& text) {
  std::string out;
  bool pendingDash = false;
  for (unsigned char c : text) {
    if (std::isalnum(c) != 0) {
      if (pendingDash && !out.empty()) out.push_back('-');
      pendingDash = false;
      out.push_back(static_cast<char>(std::tolower(c)));
    } else if (c == ' ' || c == '_' || c == '-' || c == '/') {
      pendingDash = true;
    }
  }
  if (out.empty()) return std::string();
  return out;
}

std::string formatRange(double value) {
  char buffer[40];
  std::snprintf(buffer, sizeof(buffer), "%.6g", value);
  return std::string(buffer);
}

// Best-effort current value across the value-carrying patterns.
bool readValue(IUIAutomationElement* element, std::string* out) {
  Microsoft::WRL::ComPtr<IUnknown> unknown;
  if (SUCCEEDED(element->GetCurrentPattern(UIA_ValuePatternId, &unknown)) && unknown != nullptr) {
    auto pattern = patternAs<IUIAutomationValuePattern>(unknown.Get());
    if (pattern != nullptr) {
      BSTR value = nullptr;
      if (SUCCEEDED(pattern->get_CurrentValue(&value))) {
        *out = bstrToUtf8(value);
        if (value != nullptr) SysFreeString(value);
        return true;
      }
    }
  }
  unknown.Reset();
  if (SUCCEEDED(element->GetCurrentPattern(UIA_RangeValuePatternId, &unknown)) && unknown != nullptr) {
    auto pattern = patternAs<IUIAutomationRangeValuePattern>(unknown.Get());
    if (pattern != nullptr) {
      double value = 0;
      if (SUCCEEDED(pattern->get_CurrentValue(&value))) {
        *out = formatRange(value);
        return true;
      }
    }
  }
  unknown.Reset();
  if (SUCCEEDED(element->GetCurrentPattern(UIA_TogglePatternId, &unknown)) && unknown != nullptr) {
    auto pattern = patternAs<IUIAutomationTogglePattern>(unknown.Get());
    if (pattern != nullptr) {
      ToggleState state = ToggleState_Off;
      if (SUCCEEDED(pattern->get_CurrentToggleState(&state))) {
        switch (state) {
          case ToggleState_On: *out = "on"; break;
          case ToggleState_Indeterminate: *out = "indeterminate"; break;
          default: *out = "off"; break;
        }
        return true;
      }
    }
  }
  return false;
}

std::string renderTree(const WindowSnapshot& snapshot) {
  std::string out;
  for (size_t i = 0; i < snapshot.elements.size(); ++i) {
    const ElementRecord& record = snapshot.elements[i];
    int depth = 0;
    std::string probe = record.path;
    for (char c : probe) {
      if (c == '/') ++depth;
    }
    depth = (std::max)(0, depth / 2);
    out.append(static_cast<size_t>(depth) * 2, ' ');
    char header[64];
    std::snprintf(header, sizeof(header), "[%d] ", record.index);
    out.append(header);
    out.append(record.controlType);
    if (!record.name.empty()) out.append(" \"").append(record.name).append("\"");
    char bounds[80];
    std::snprintf(bounds, sizeof(bounds), " (%ld,%ld,%ld,%ld)", record.bounds.left, record.bounds.top,
                  record.bounds.right - record.bounds.left, record.bounds.bottom - record.bounds.top);
    out.append(bounds);
    if (record.hasValue) out.append(" = \"").append(record.value).append("\"");
    out.push_back('\n');
  }
  return out;
}

void walkElement(IUIAutomationElement* element, const std::string& ancestorChain, bool isRoot, int depth,
                 WindowSnapshot* snapshot) {
  if (snapshot->elements.size() >= kMaxElements || depth > kMaxDepth) return;

  ElementRecord record;
  record.index = static_cast<int>(snapshot->elements.size());

  CONTROLTYPEID typeId = 0;
  element->get_CurrentControlType(&typeId);
  record.controlType = controlTypeSegment(typeId);

  BSTR name = nullptr;
  if (SUCCEEDED(element->get_CurrentName(&name)) && name != nullptr) {
    record.name = bstrToUtf8(name);
    SysFreeString(name);
  }

  BSTR automationId = nullptr;
  if (SUCCEEDED(element->get_CurrentAutomationId(&automationId)) && automationId != nullptr) {
    record.automationId = bstrToUtf8(automationId);
    SysFreeString(automationId);
  }

  BSTR className = nullptr;
  if (SUCCEEDED(element->get_CurrentClassName(&className)) && className != nullptr) {
    record.className = bstrToUtf8(className);
    SysFreeString(className);
  }

  element->get_CurrentBoundingRectangle(&record.bounds);
  BOOL offscreen = FALSE;
  element->get_CurrentIsOffscreen(&offscreen);
  record.offscreen = offscreen != FALSE;
  BOOL enabled = TRUE;
  element->get_CurrentIsEnabled(&enabled);
  record.enabled = enabled != FALSE;
  record.hasValue = readValue(element, &record.value);

  // This element's own path: ancestors' chain + /<type>/<identifier>, unique
  // within the snapshot. The root keeps "" (the window id is the caller's prefix).
  std::string identifier = record.automationId;
  if (identifier.empty()) identifier = slug(record.name);
  if (identifier.empty()) identifier = std::to_string(record.index);
  if (!isRoot) {
    std::string segment = "/" + record.controlType + "/" + identifier;
    std::string path = ancestorChain + segment;
    if (snapshot->usedPaths.count(path) != 0) {
      long suffix = record.index;
      do {
        path = ancestorChain + segment + "-" + std::to_string(suffix);
        ++suffix;
      } while (snapshot->usedPaths.count(path) != 0);
    }
    record.path = path;
    snapshot->usedPaths.insert(path);
  }

  snapshot->elements.push_back(record);
  // The snapshot slot holds its own reference (ComPtr(T*) constructor AddRefs).
  snapshot->refs.emplace_back(element);

  // Descendants build on this element's chain (the root contributes nothing:
  // the caller prefixes the window id).
  std::string childChain = isRoot ? std::string() : record.path;

  if (g_walker == nullptr) return;
  Microsoft::WRL::ComPtr<IUIAutomationElement> child;
  if (FAILED(g_walker->GetFirstChildElement(element, &child)) || child == nullptr) return;
  while (child != nullptr) {
    walkElement(child.Get(), childChain, false, depth + 1, snapshot);
    Microsoft::WRL::ComPtr<IUIAutomationElement> sibling;
    g_walker->GetNextSiblingElement(child.Get(), &sibling);
    child = sibling;
  }
}

std::string signatureOf(const ElementRecord& record) {
  return std::to_string(record.index) + "|" + record.controlType + "|" + record.name + "|" +
         (record.hasValue ? record.value : std::string()) + "|" + std::to_string(record.bounds.left) + "," +
         std::to_string(record.bounds.top) + "," + std::to_string(record.bounds.right) + "," +
         std::to_string(record.bounds.bottom);
}

Json boundsJson(const RECT& bounds) {
  Json out = Json::makeObject();
  out.set("x", Json::makeNumber(static_cast<double>(bounds.left)));
  out.set("y", Json::makeNumber(static_cast<double>(bounds.top)));
  out.set("width", Json::makeNumber(static_cast<double>(bounds.right - bounds.left)));
  out.set("height", Json::makeNumber(static_cast<double>(bounds.bottom - bounds.top)));
  return out;
}

}  // namespace

bool initUia(std::string* errorOut) {
  if (g_uia != nullptr) return true;
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(g_uia.GetAddressOf()));
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "CoCreateInstance(CLSID_CUIAutomation) failed: hr=" + hexHr(hr);
    return false;
  }
  hr = g_uia->get_ControlViewWalker(g_walker.GetAddressOf());
  if (FAILED(hr) || g_walker == nullptr) {
    if (errorOut != nullptr) *errorOut = "get_ControlViewWalker failed: hr=" + hexHr(hr);
    g_uia.Reset();
    return false;
  }
  return true;
}

bool uiaReady() { return g_uia != nullptr && g_walker != nullptr; }

Json buildAccessibility(HWND hwnd, bool includeText, bool disableDiff, std::string* errorOut) {
  if (!uiaReady()) {
    if (errorOut != nullptr) *errorOut = "UIA is not initialized";
    return Json();
  }

  Microsoft::WRL::ComPtr<IUIAutomationElement> root;
  HRESULT hr = g_uia->ElementFromHandle(hwnd, root.GetAddressOf());
  if (FAILED(hr) || root == nullptr) {
    if (errorOut != nullptr) *errorOut = "ElementFromHandle failed for the target window: hr=" + hexHr(hr);
    return Json();
  }

  WindowSnapshot fresh;
  fresh.hwnd = hwnd;
  walkElement(root.Get(), std::string(), true, 0, &fresh);
  for (size_t i = 0; i < fresh.elements.size(); ++i) fresh.signatures.push_back(signatureOf(fresh.elements[i]));

  Json result = Json::makeObject();
  if (includeText) {
    result.set("tree", Json::makeString(renderTree(fresh)));

    const WindowSnapshot* previous = nullptr;
    auto found = g_snapshots.find(hwnd);
    if (found != g_snapshots.end()) previous = &found->second;

    Json elements = Json::makeArray();
    bool incremental = !disableDiff;
    bool anyChanged = false;
    for (size_t i = 0; i < fresh.elements.size(); ++i) {
      bool changed = true;
      if (incremental) {
        if (previous == nullptr) {
          changed = true;
        } else if (i < previous->signatures.size()) {
          changed = previous->signatures[i] != fresh.signatures[i];
        } else {
          changed = true;
        }
      }
      if (!changed) continue;
      anyChanged = true;
      const ElementRecord& record = fresh.elements[i];
      Json element = Json::makeObject();
      element.set("element_index", Json::makeNumber(static_cast<double>(record.index)));
      element.set("path", Json::makeString(record.path));
      element.set("controlType", Json::makeString(record.controlType));
      element.set("name", Json::makeString(record.name));
      if (record.hasValue) element.set("value", Json::makeString(record.value));
      element.set("bounds", boundsJson(record.bounds));
      element.set("enabled", Json::makeBool(record.enabled));
      element.set("offscreen", Json::makeBool(record.offscreen));
      if (!record.automationId.empty()) element.set("automationId", Json::makeString(record.automationId));
      if (!record.className.empty()) element.set("className", Json::makeString(record.className));
      elements.push(std::move(element));
    }
    result.set("elements", std::move(elements));
    result.set("diff", Json::makeString(incremental ? "incremental" : "full"));
    if (incremental) {
      result.set("changed", Json::makeBool(anyChanged));
      result.set("unchanged", Json::makeBool(!anyChanged));
    }

    // Focused element, located inside the fresh snapshot when present.
    Microsoft::WRL::ComPtr<IUIAutomationElement> focused;
    if (SUCCEEDED(g_uia->GetFocusedElement(focused.GetAddressOf())) && focused != nullptr) {
      std::string rendered;
      int focusedIndex = -1;
      for (size_t i = 0; i < fresh.refs.size(); ++i) {
        BOOL same = FALSE;
        if (fresh.refs[i] != nullptr && SUCCEEDED(g_uia->CompareElements(fresh.refs[i].Get(), focused.Get(), &same)) && same) {
          focusedIndex = static_cast<int>(i);
          break;
        }
      }
      BSTR name = nullptr;
      focused->get_CurrentName(&name);
      CONTROLTYPEID typeId = 0;
      focused->get_CurrentControlType(&typeId);
      char header[32];
      if (focusedIndex >= 0) {
        std::snprintf(header, sizeof(header), "[%d] ", focusedIndex);
      } else {
        std::snprintf(header, sizeof(header), "[?] ");
      }
      rendered.assign(header);
      rendered.append(controlTypeSegment(typeId));
      rendered.append(" \"");
      if (name != nullptr) {
        rendered.append(bstrToUtf8(name));
        SysFreeString(name);
      }
      rendered.append("\"");
      result.set("focused_element", Json::makeString(rendered));
    }
  }

  g_snapshots[hwnd] = std::move(fresh);
  return result;
}

Microsoft::WRL::ComPtr<IUIAutomationElement> snapshotElement(HWND hwnd, int index, std::string* errorOut) {
  auto found = g_snapshots.find(hwnd);
  if (found == g_snapshots.end() || found->second.refs.empty()) {
    if (errorOut != nullptr) *errorOut = "no element snapshot for this window; call get_window_state first";
    return nullptr;
  }
  if (index < 0 || static_cast<size_t>(index) >= found->second.refs.size()) {
    if (errorOut != nullptr)
      *errorOut = "element_index " + std::to_string(index) + " is out of range for the current snapshot; refresh with get_window_state";
    return nullptr;
  }
  if (found->second.refs[static_cast<size_t>(index)] == nullptr) {
    if (errorOut != nullptr) *errorOut = "element_index " + std::to_string(index) + " no longer resolves";
    return nullptr;
  }
  return found->second.refs[static_cast<size_t>(index)];
}

Json performSecondaryAction(HWND hwnd, int index, const std::string& action, std::string* errorOut) {
  auto element = snapshotElement(hwnd, index, errorOut);
  if (element == nullptr) return Json();

  Json result = Json::makeObject();
  result.set("element_index", Json::makeNumber(static_cast<double>(index)));
  result.set("action", Json::makeString(action));

  if (action == "Raise") {
    element->SetFocus();
    UIA_HWND rawHandle = nullptr;
    element->get_CurrentNativeWindowHandle(&rawHandle);
    HWND nativeHandle = static_cast<HWND>(rawHandle);
    HWND target = nativeHandle != nullptr ? nativeHandle : hwnd;
    if (target != nullptr) SetForegroundWindow(target);
    if (target != nullptr) awaitForeground(target, 150);
    bool transferred = GetForegroundWindow() == target;
    result.set("applied", Json::makeBool(true));
    result.set("focusTransferred", Json::makeBool(transferred));
    result.set("detail", Json::makeString(transferred
                                              ? "Raise: SetFocus + SetForegroundWindow landed on the interactive desktop"
                                              : "Raise: focus did not transfer (cross-desktop/UIPI boundary)"));
    return result;
  }

  if (action == "Scroll Up" || action == "Scroll Down" || action == "Scroll Left" || action == "Scroll Right") {
    Microsoft::WRL::ComPtr<IUnknown> unknown;
    HRESULT hr = element->GetCurrentPattern(UIA_ScrollPatternId, unknown.GetAddressOf());
    auto pattern = (SUCCEEDED(hr) && unknown != nullptr) ? patternAs<IUIAutomationScrollPattern>(unknown.Get()) : nullptr;
    if (pattern == nullptr) {
      if (errorOut != nullptr) *errorOut = "element_index " + std::to_string(index) + " does not expose the Scroll pattern";
      return Json();
    }
    ScrollAmount horizontal = ScrollAmount_NoAmount;
    ScrollAmount vertical = ScrollAmount_NoAmount;
    if (action == "Scroll Up") vertical = ScrollAmount_SmallDecrement;
    if (action == "Scroll Down") vertical = ScrollAmount_SmallIncrement;
    if (action == "Scroll Left") horizontal = ScrollAmount_SmallDecrement;
    if (action == "Scroll Right") horizontal = ScrollAmount_SmallIncrement;
    hr = pattern->Scroll(horizontal, vertical);
    if (FAILED(hr)) {
      if (errorOut != nullptr) *errorOut = "ScrollPattern.Scroll failed for " + action + ": hr=" + hexHr(hr);
      return Json();
    }
    result.set("applied", Json::makeBool(true));
    result.set("detail", Json::makeString("ScrollPattern.Scroll applied " + action));
    return result;
  }

  if (action == "Expand" || action == "Collapse") {
    Microsoft::WRL::ComPtr<IUnknown> unknown;
    HRESULT hr = element->GetCurrentPattern(UIA_ExpandCollapsePatternId, unknown.GetAddressOf());
    auto pattern = (SUCCEEDED(hr) && unknown != nullptr) ? patternAs<IUIAutomationExpandCollapsePattern>(unknown.Get()) : nullptr;
    if (pattern == nullptr) {
      if (errorOut != nullptr) *errorOut = "element_index " + std::to_string(index) + " does not expose the ExpandCollapse pattern";
      return Json();
    }
    hr = action == "Expand" ? pattern->Expand() : pattern->Collapse();
    if (FAILED(hr)) {
      if (errorOut != nullptr) *errorOut = action + " failed: hr=" + hexHr(hr);
      return Json();
    }
    ExpandCollapseState state = ExpandCollapseState_Collapsed;
    pattern->get_CurrentExpandCollapseState(&state);
    result.set("applied", Json::makeBool(true));
    result.set("state", Json::makeString(state == ExpandCollapseState_Expanded ? "expanded"
                                         : state == ExpandCollapseState_PartiallyExpanded ? "partiallyExpanded"
                                         : state == ExpandCollapseState_LeafNode ? "leafNode"
                                                                                   : "collapsed"));
    return result;
  }

  if (errorOut != nullptr)
    *errorOut = "unsupported secondary action " + action +
                "; supported: Raise, Scroll Up, Scroll Down, Scroll Left, Scroll Right, Expand, Collapse";
  return Json();
}

Json setElementValue(HWND hwnd, int index, const std::string& value, std::string* errorOut) {
  auto element = snapshotElement(hwnd, index, errorOut);
  if (element == nullptr) return Json();

  Microsoft::WRL::ComPtr<IUnknown> unknown;
  HRESULT hr = element->GetCurrentPattern(UIA_ValuePatternId, unknown.GetAddressOf());
  auto pattern = (SUCCEEDED(hr) && unknown != nullptr) ? patternAs<IUIAutomationValuePattern>(unknown.Get()) : nullptr;
  if (pattern == nullptr) {
    if (errorOut != nullptr) *errorOut = "element_index " + std::to_string(index) + " does not expose the Value pattern";
    return Json();
  }
  BOOL readOnly = FALSE;
  pattern->get_CurrentIsReadOnly(&readOnly);
  if (readOnly) {
    if (errorOut != nullptr) *errorOut = "element_index " + std::to_string(index) + " is read-only";
    return Json();
  }
  std::wstring wide = utf8ToWide(value);
  BSTR wideValue = SysAllocString(wide.c_str());
  hr = pattern->SetValue(wideValue);
  SysFreeString(wideValue);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "ValuePattern.SetValue failed: hr=" + hexHr(hr);
    return Json();
  }
  Json result = Json::makeObject();
  result.set("element_index", Json::makeNumber(static_cast<double>(index)));
  result.set("value", Json::makeString(value));
  result.set("applied", Json::makeBool(true));
  return result;
}

void clearUiaCaches() { g_snapshots.clear(); }

}  // namespace cua

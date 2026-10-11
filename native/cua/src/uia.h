// Native COM UIA subsystem: raw vtable COM calls into uiautomationcore.dll
// (IUIAutomation / IUIAutomationElement / IUIAutomationTreeWalker). No .NET,
// no PowerShell, no managed UIA anywhere in this binary.
#pragma once

#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>

#include <map>
#include <set>
#include <string>
#include <vector>

#include "json.h"

namespace cua {

struct ElementRecord {
  int index = 0;
  std::string path;          // relative to the window root, "" for the root itself
  std::string controlType;   // lowercase UIA control type, e.g. "edit"
  std::string name;
  std::string value;
  bool hasValue = false;
  RECT bounds{};
  bool offscreen = false;
  bool enabled = true;
  std::string automationId;
  std::string className;
};

struct WindowSnapshot {
  HWND hwnd = nullptr;
  std::vector<ElementRecord> elements;
  std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>> refs;
  std::vector<std::string> signatures;
  std::set<std::string> usedPaths;
};

// One-time COM setup: CoInitializeEx caller-side, then CoCreateInstance of the
// UIAutomation COM server + the Control View tree walker.
bool initUia(std::string* errorOut);

// True once initUia() succeeded.
bool uiaReady();

// Rebuild the full snapshot for a window. When includeText is set, returns the
// accessibility object (tree string, structured elements honoring disableDiff,
// focused element). disableDiff=true returns every element; the default
// incremental mode returns only elements whose signature changed since the
// previous read (unchanged -> empty list + unchanged=true).
Json buildAccessibility(HWND hwnd, bool includeText, bool disableDiff, std::string* errorOut);

// element_index contract: index into the most recent snapshot for the window.
Microsoft::WRL::ComPtr<IUIAutomationElement> snapshotElement(HWND hwnd, int index, std::string* errorOut);

// Secondary actions: Raise / Scroll Up|Down|Left|Right / Expand / Collapse.
Json performSecondaryAction(HWND hwnd, int index, const std::string& action, std::string* errorOut);

// ValuePattern.SetValue for one snapshot element.
Json setElementValue(HWND hwnd, int index, const std::string& value, std::string* errorOut);

// end_turn: drop cached snapshots and incremental-diff state.
void clearUiaCaches();

}  // namespace cua

// SendInput synthesis: real OS-level input injection (never PostMessage).
// Every outcome reports what actually landed: event counts, cursor position
// after the move, foreground transfer, and any UIPI boundary on the target.
#pragma once

#include <windows.h>

#include <string>

#include "json.h"

namespace cua {

struct InputOutcome {
  bool delivered = false;
  std::string detail;
  HWND target = nullptr;
  HWND foreground = nullptr;
  bool focusTransferred = false;
};

// Resolve a request point to absolute screen pixels.
// space == "window" treats (x, y) as relative to the target window's outer
// rect origin; anything else is already screen space (virtual-desktop pixels).
bool inputSpacePoint(HWND target, const std::string& space, double x, double y, POINT* out, std::string* errorOut);

InputOutcome moveTo(HWND target, double x, double y, const std::string& space);
InputOutcome clickAt(HWND target, double x, double y, const std::string& space, const std::string& button, int clickCount);
InputOutcome scrollAt(HWND target, double x, double y, const std::string& space, double deltaX, double deltaY);
InputOutcome dragTo(HWND target, double fromX, double fromY, double toX, double toY, const std::string& space);
InputOutcome pressCombo(HWND target, const std::string& key);
InputOutcome typeText(HWND target, const std::string& text);
InputOutcome activateTarget(HWND target);

bool injectorElevated();

/**
 * Poll until the foreground window becomes `target` or the timeout passes.
 * Foreground transfer is observed through the target's message pump, so a
 * click/activation can land one pump cycle after SendInput returns.
 * Returns true when `target` is foreground when the wait ends.
 */
bool awaitForeground(HWND target, DWORD timeoutMs);

Json outcomeJson(const InputOutcome& outcome);

}  // namespace cua

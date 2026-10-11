// Capture subsystem: Windows.Graphics.Capture (WGC/WinRT + Direct3D11 frame
// pool + IGraphicsCaptureItemInterop) with a PrintWindow/BitBlt GDI fallback.
// No GDI in the primary path - GDI only exists as the documented fallback mode.
#pragma once

#include <windows.h>

#include <string>
#include <vector>

#include "json.h"

namespace cua {

struct RegionSample {
  std::string name;
  bool windowSpace = true;  // true: relative to the window rect origin; false: absolute screen pixels
  double x = 0;
  double y = 0;
};

struct CaptureResult {
  int width = 0;
  int height = 0;
  std::string mode;  // "wgc" or "gdi" - whichever produced the window frame
  Json regions;      // object: region name -> "#rrggbb"
  std::string fallbackReason;  // set when WGC was requested but GDI produced the window frame
  std::string desktopSource;   // "wgc" | "none" when desktop samples were requested
};

struct FrameShot {
  std::string id;
  int zIndex = 0;
  std::string dataUrl;  // data:image/png;base64,...
  int originX = 0;
  int originY = 0;
  int width = 0;
  int height = 0;
};

// Sample region colors in one capture round. mode: ""/"wgc" selects WGC with
// automatic GDI fallback; "gdi" forces the window-blit fallback (desktop-scope
// regions then report the #000000 miss sentinel - a window blit has no desktop
// pixels). Returns false only when neither mode could produce a frame.
bool captureRegions(HWND window, const std::vector<RegionSample>& samples, const std::string& mode,
                    CaptureResult* result, std::string* errorOut);

// PNG screenshots: window frame (zIndex 0) plus the desktop context (zIndex 1,
// WGC only). usedMode reports which mechanism produced the shots.
bool captureScreenshotFrames(HWND window, std::vector<FrameShot>* shots, std::string* usedMode, std::string* errorOut);

// Diagnostic: WGC readiness + adapter identity + a forced fresh frame for the
// monitor (no window) or one target window (exposed as `probe_capture`).
Json captureProbeResult(HWND window);

}  // namespace cua

#include "capture.h"

#include <d3d11.h>
#include <dwmapi.h>
#include <dxgi.h>
#include <wincodec.h>

#include <windows.graphics.directx.direct3d11.interop.h>
#include <Windows.Graphics.Capture.Interop.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <wrl/client.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>

#include "util.h"

namespace cua {
namespace {

namespace Capture = winrt::Windows::Graphics::Capture;
namespace DirectXGfx = winrt::Windows::Graphics::DirectX;
namespace Direct3D11Gfx = winrt::Windows::Graphics::DirectX::Direct3D11;

constexpr DWORD kFrameTimeoutMs = 2500;       // monitor frames (always deliver)
constexpr DWORD kWindowFrameTimeoutMs = 1000; // foreground windows deliver in ~30-80ms
constexpr DWORD kGdiWindowClassMask = 0x00000002;  // PW_RENDERFULLCONTENT

// C++/WinRT class types carry winrt::guid, not an MSVC __uuidof GUID; bridge
// to the COM REFIID the interop factory expects (identical layout).
const ::IID& iidGraphicsCaptureItem() {
  static const ::IID iid = *reinterpret_cast<const ::IID*>(&winrt::guid_of<Capture::GraphicsCaptureItem>());
  return iid;
}

struct PixelBuffer {
  int width = 0;
  int height = 0;
  LONG originX = 0;
  LONG originY = 0;
  std::vector<unsigned char> bgra;  // top-down, stride = width * 4
};

struct WgcContext {
  Capture::Direct3D11CaptureFramePool pool{nullptr};
  Capture::GraphicsCaptureSession session{nullptr};
  Capture::GraphicsCaptureItem item{nullptr};
  winrt::event_token arrival{};
  HANDLE frameEvent = nullptr;
  int width = 0;
  int height = 0;
  int stagingWidth = 0;
  int stagingHeight = 0;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;

  void reset() {
    if (arrival.value != 0 && pool != nullptr) {
      try {
        pool.FrameArrived(arrival);
      } catch (...) {
      }
      arrival = {};
    }
    if (session != nullptr) {
      try {
        session.Close();
      } catch (...) {
      }
      session = nullptr;
    }
    if (pool != nullptr) {
      try {
        pool.Close();
      } catch (...) {
      }
      pool = nullptr;
    }
    if (frameEvent != nullptr) {
      CloseHandle(frameEvent);
      frameEvent = nullptr;
    }
    item = nullptr;
    staging.Reset();
    stagingWidth = stagingHeight = 0;
    width = height = 0;
  }
};

bool g_probed = false;
bool g_ready = false;
bool g_usedWarp = false;
std::string g_adapterName;
std::string g_unavailableReason;
Microsoft::WRL::ComPtr<ID3D11Device> g_device;
Microsoft::WRL::ComPtr<ID3D11DeviceContext> g_context;
Direct3D11Gfx::IDirect3DDevice g_winrtDevice{nullptr};
Microsoft::WRL::ComPtr<IWICImagingFactory> g_wic;
std::map<HWND, WgcContext> g_windowContexts;
std::map<HMONITOR, WgcContext> g_monitorContexts;

bool ensureCaptureReady(std::string* reasonOut) {
  if (g_probed) {
    if (!g_ready && reasonOut != nullptr) *reasonOut = g_unavailableReason;
    return g_ready;
  }
  g_probed = true;

  if (!Capture::GraphicsCaptureSession::IsSupported()) {
    g_unavailableReason = "Windows.Graphics.Capture is not supported in this session";
    return false;
  }

  const D3D_FEATURE_LEVEL wanted[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1,
                                      D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL obtained{};
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, wanted,
                                 ARRAYSIZE(wanted), D3D11_SDK_VERSION, &g_device, &obtained, &g_context);
  g_usedWarp = FAILED(hr);
  if (g_usedWarp) {
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, wanted,
                           ARRAYSIZE(wanted), D3D11_SDK_VERSION, &g_device, &obtained, &g_context);
  }
  if (FAILED(hr)) {
    g_unavailableReason = "D3D11CreateDevice failed: hr=" + hexHr(hr);
    return false;
  }
  {
    Microsoft::WRL::ComPtr<IDXGIDevice> probeDevice;
    Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
    if (SUCCEEDED(g_device.As(&probeDevice)) && SUCCEEDED(probeDevice->GetAdapter(adapter.GetAddressOf())) &&
        adapter != nullptr) {
      DXGI_ADAPTER_DESC desc{};
      if (SUCCEEDED(adapter->GetDesc(&desc))) g_adapterName = wideToUtf8(desc.Description);
    }
  }

  Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
  hr = g_device.As(&dxgiDevice);
  if (FAILED(hr)) {
    g_unavailableReason = "QI IDXGIDevice failed: hr=" + hexHr(hr);
    return false;
  }
  winrt::com_ptr<IInspectable> inspectable;
  hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put());
  if (FAILED(hr)) {
    g_unavailableReason = "CreateDirect3D11DeviceFromDXGIDevice failed: hr=" + hexHr(hr);
    return false;
  }
  try {
    g_winrtDevice = inspectable.as<Direct3D11Gfx::IDirect3DDevice>();
  } catch (const winrt::hresult_error& error) {
    g_unavailableReason = "IDirect3DDevice wrap failed: hr=" + hexHr(error.code());
    return false;
  }

  hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(g_wic.GetAddressOf()));
  if (FAILED(hr)) {
    g_unavailableReason = "CLSID_WICImagingFactory failed: hr=" + hexHr(hr);
    return false;
  }

  g_ready = true;
  return true;
}

bool frameToBuffer(Capture::Direct3D11CaptureFrame& frame, WgcContext* context, PixelBuffer* out, std::string* errorOut) {
  auto surface = frame.Surface();
  auto* rawInspectable = reinterpret_cast<::IInspectable*>(winrt::get_abi(surface));
  if (rawInspectable == nullptr) {
    if (errorOut != nullptr) *errorOut = "frame surface is null";
    return false;
  }
  Microsoft::WRL::ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
  HRESULT hr = rawInspectable->QueryInterface(IID_PPV_ARGS(&access));
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "IDirect3DDxgiInterfaceAccess QI failed: hr=" + hexHr(hr);
    return false;
  }
  Microsoft::WRL::ComPtr<IDXGISurface> dxgiSurface;
  hr = access->GetInterface(IID_PPV_ARGS(&dxgiSurface));
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "GetInterface(IDXGISurface) failed: hr=" + hexHr(hr);
    return false;
  }
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  hr = dxgiSurface.As(&texture);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "QI ID3D11Texture2D failed: hr=" + hexHr(hr);
    return false;
  }

  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  if (context->staging == nullptr || context->stagingWidth != static_cast<int>(desc.Width) ||
      context->stagingHeight != static_cast<int>(desc.Height)) {
    D3D11_TEXTURE2D_DESC stagingDesc = desc;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.BindFlags = 0;
    stagingDesc.MiscFlags = 0;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    context->staging.Reset();
    hr = g_device->CreateTexture2D(&stagingDesc, nullptr, context->staging.GetAddressOf());
    if (FAILED(hr)) {
      if (errorOut != nullptr) *errorOut = "staging texture CreateTexture2D failed: hr=" + hexHr(hr);
      return false;
    }
    context->stagingWidth = static_cast<int>(desc.Width);
    context->stagingHeight = static_cast<int>(desc.Height);
  }

  g_context->CopyResource(context->staging.Get(), texture.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = g_context->Map(context->staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "staging Map failed: hr=" + hexHr(hr);
    return false;
  }
  out->width = context->stagingWidth;
  out->height = context->stagingHeight;
  out->bgra.resize(static_cast<size_t>(out->width) * static_cast<size_t>(out->height) * 4);
  size_t rowBytes = static_cast<size_t>(out->width) * 4;
  for (int y = 0; y < out->height; ++y) {
    std::memcpy(out->bgra.data() + static_cast<size_t>(y) * rowBytes,
                static_cast<const unsigned char*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch, rowBytes);
  }
  g_context->Unmap(context->staging.Get(), 0);
  return true;
}

bool waitForFrame(WgcContext* context, DWORD timeoutMs, std::string* errorOut) {
  ResetEvent(context->frameEvent);
  DWORD wait = WaitForSingleObject(context->frameEvent, timeoutMs);
  if (wait != WAIT_OBJECT_0) {
    if (errorOut != nullptr) *errorOut = "timed out waiting for a WGC frame (window hidden, minimized, or occluded?)";
    return false;
  }
  return true;
}

// Grab a fresh frame from an existing context into a top-down BGRA buffer.
bool grabWgc(WgcContext* context, LONG originX, LONG originY, DWORD timeoutMs, PixelBuffer* out, std::string* errorOut) {
  if (context->frameEvent == nullptr || context->pool == nullptr) {
    if (errorOut != nullptr) *errorOut = "WGC context is not started";
    return false;
  }
  for (int attempt = 0; attempt < 3; ++attempt) {
    Capture::Direct3D11CaptureFrame frame{nullptr};
    if (waitForFrame(context, timeoutMs, errorOut)) {
      frame = context->pool.TryGetNextFrame();
    } else {
      // FrameArrived can pause while the captured surface is static; the most
      // recently delivered frame may still sit in the pool queue.
      frame = context->pool.TryGetNextFrame();
      if (frame == nullptr) return false;
    }
    if (frame == nullptr) continue;
    auto content = frame.ContentSize();
    if (content.Width != context->width || content.Height != context->height) {
      // The target resized: realign the pool and wait for a matching frame.
      context->pool.Recreate(g_winrtDevice, DirectXGfx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
      context->width = content.Width;
      context->height = content.Height;
      continue;
    }
    if (!frameToBuffer(frame, context, out, errorOut)) return false;
    out->originX = originX;
    out->originY = originY;
    return true;
  }
  if (errorOut != nullptr) *errorOut = "no stable WGC frame after retries";
  return false;
}

bool ensureWindowContext(HWND window, WgcContext** out, std::string* errorOut) {
  RECT rect{};
  if (!GetWindowRect(window, &rect)) {
    if (errorOut != nullptr) *errorOut = "GetWindowRect failed for the capture target";
    return false;
  }
  int width = rect.right - rect.left;
  int height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    if (errorOut != nullptr) *errorOut = "capture target has empty bounds (minimized?)";
    return false;
  }

  WgcContext& context = g_windowContexts[window];
  if (context.session != nullptr && context.item != nullptr) {
    // The pool must track the ITEM (WGC content) size, not the window rect:
    // they differ by the invisible DWM borders, and ping-ponging between the
    // two starves frame delivery (measured: capture recreated the pool on every
    // request and timed out while the probe succeeded).
    try {
      auto size = context.item.Size();
      if (context.width != size.Width || context.height != size.Height) {
        context.pool.Recreate(g_winrtDevice, DirectXGfx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
        context.width = size.Width;
        context.height = size.Height;
      }
    } catch (...) {
      context.reset();
    }
  }
  if (context.session == nullptr) {
    try {
      auto factory = winrt::get_activation_factory<Capture::GraphicsCaptureItem>();
      auto interop = factory.as<IGraphicsCaptureItemInterop>();
      HRESULT hr = interop->CreateForWindow(window, iidGraphicsCaptureItem(),
                                            reinterpret_cast<void**>(winrt::put_abi(context.item)));
      if (FAILED(hr)) {
        if (errorOut != nullptr)
          *errorOut = "IGraphicsCaptureItemInterop::CreateForWindow failed: hr=" + hexHr(hr) + " (hidden or minimized window?)";
        g_windowContexts.erase(window);
        return false;
      }
      auto size = context.item.Size();
      int poolWidth = size.Width > 0 ? size.Width : width;
      int poolHeight = size.Height > 0 ? size.Height : height;
      context.pool = Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
          g_winrtDevice, DirectXGfx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, {poolWidth, poolHeight});
      context.session = context.pool.CreateCaptureSession(context.item);
      try {
        context.session.IsCursorCaptureEnabled(false);
      } catch (...) {
      }
      context.frameEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (context.frameEvent == nullptr) {
        if (errorOut != nullptr) *errorOut = "CreateEventW failed";
        g_windowContexts.erase(window);
        return false;
      }
      HANDLE eventHandle = context.frameEvent;
      context.arrival = context.pool.FrameArrived([eventHandle](auto&&, auto&&) { SetEvent(eventHandle); });
      context.session.StartCapture();
      context.width = poolWidth;
      context.height = poolHeight;
    } catch (const winrt::hresult_error& error) {
      if (errorOut != nullptr) *errorOut = "WGC window context start failed: hr=" + hexHr(error.code());
      g_windowContexts.erase(window);
      return false;
    }
  }
  *out = &context;
  return true;
}

bool ensureMonitorContext(HMONITOR monitor, WgcContext** out, std::string* errorOut) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) {
    if (errorOut != nullptr) *errorOut = "GetMonitorInfoW failed";
    return false;
  }
  int width = info.rcMonitor.right - info.rcMonitor.left;
  int height = info.rcMonitor.bottom - info.rcMonitor.top;
  if (width <= 0 || height <= 0) {
    if (errorOut != nullptr) *errorOut = "monitor has empty bounds";
    return false;
  }

  WgcContext& context = g_monitorContexts[monitor];
  if (context.session == nullptr) {
    try {
      auto factory = winrt::get_activation_factory<Capture::GraphicsCaptureItem>();
      auto interop = factory.as<IGraphicsCaptureItemInterop>();
      HRESULT hr = interop->CreateForMonitor(monitor, iidGraphicsCaptureItem(),
                                             reinterpret_cast<void**>(winrt::put_abi(context.item)));
      if (FAILED(hr)) {
        if (errorOut != nullptr) *errorOut = "CreateForMonitor failed: hr=" + hexHr(hr);
        g_monitorContexts.erase(monitor);
        return false;
      }
      context.pool = Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
          g_winrtDevice, DirectXGfx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, {width, height});
      context.session = context.pool.CreateCaptureSession(context.item);
      try {
        context.session.IsCursorCaptureEnabled(false);
      } catch (...) {
      }
      context.frameEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (context.frameEvent == nullptr) {
        if (errorOut != nullptr) *errorOut = "CreateEventW failed";
        g_monitorContexts.erase(monitor);
        return false;
      }
      HANDLE eventHandle = context.frameEvent;
      context.arrival = context.pool.FrameArrived([eventHandle](auto&&, auto&&) { SetEvent(eventHandle); });
      context.session.StartCapture();
      context.width = width;
      context.height = height;
    } catch (const winrt::hresult_error& error) {
      if (errorOut != nullptr) *errorOut = "WGC monitor context start failed: hr=" + hexHr(error.code());
      g_monitorContexts.erase(monitor);
      return false;
    }
  }
  *out = &context;
  return true;
}

// Negative cache: on this build a WOCCLUDED window yields no window-item
// frames at all (foreground windows deliver in ~30-80ms). After one measured
// timeout, skip WGC for that HWND until it is foreground again or 30s pass.
std::map<HWND, ULONGLONG> g_windowWgcFailAt;

bool windowWgcAllowed(HWND window) {
  auto failedAt = g_windowWgcFailAt.find(window);
  if (failedAt == g_windowWgcFailAt.end()) return true;
  if (GetForegroundWindow() == window) return true;
  return GetTickCount64() - failedAt->second > 30000;
}

bool grabWindowWgcFrame(HWND window, PixelBuffer* out, std::string* errorOut, bool force = false) {
  if (!force && !windowWgcAllowed(window)) {
    if (errorOut != nullptr) {
      *errorOut = "WGC window capture negative-cached for an occluded window (retry when foreground)";
    }
    return false;
  }
  WgcContext* context = nullptr;
  RECT rect{};
  if (!GetWindowRect(window, &rect)) {
    if (errorOut != nullptr) *errorOut = "GetWindowRect failed";
    return false;
  }
  // WGC's window frame covers the *visible* bounds (DWM extended frame): the
  // invisible resize borders are not part of the capture, so sample coordinates
  // must start at the visual origin, not the raw window-rect origin.
  RECT visual{};
  LONG originX = rect.left;
  LONG originY = rect.top;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &visual, sizeof(visual)))) {
    originX = visual.left;
    originY = visual.top;
  }
  if (!ensureWindowContext(window, &context, errorOut)) return false;
  if (!grabWgc(context, originX, originY, kWindowFrameTimeoutMs, out, errorOut)) {
    // One full retry: drop the stale context (destroyed window) and start over.
    g_windowContexts[window].reset();
    g_windowContexts.erase(window);
    if (!ensureWindowContext(window, &context, errorOut)) return false;
    if (!grabWgc(context, originX, originY, kWindowFrameTimeoutMs, out, errorOut)) {
      g_windowWgcFailAt[window] = GetTickCount64();
      return false;
    }
  }
  g_windowWgcFailAt.erase(window);
  return true;
}

bool grabMonitorWgcFrame(POINT point, PixelBuffer* out, std::string* errorOut) {
  HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
  if (monitor == nullptr) {
    if (errorOut != nullptr) *errorOut = "MonitorFromPoint failed";
    return false;
  }
  WgcContext* context = nullptr;
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  GetMonitorInfoW(monitor, &info);
  if (!ensureMonitorContext(monitor, &context, errorOut)) return false;
  if (!grabWgc(context, info.rcMonitor.left, info.rcMonitor.top, kFrameTimeoutMs, out, errorOut)) {
    g_monitorContexts[monitor].reset();
    g_monitorContexts.erase(monitor);
    if (!ensureMonitorContext(monitor, &context, errorOut)) return false;
    if (!grabWgc(context, info.rcMonitor.left, info.rcMonitor.top, kFrameTimeoutMs, out, errorOut)) return false;
  }
  return true;
}

bool grabWindowGdi(HWND window, PixelBuffer* out, std::string* errorOut) {
  RECT rect{};
  if (!GetWindowRect(window, &rect)) {
    if (errorOut != nullptr) *errorOut = "GetWindowRect failed";
    return false;
  }
  int width = rect.right - rect.left;
  int height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    if (errorOut != nullptr) *errorOut = "capture target has empty bounds";
    return false;
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;  // top-down
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC memory = CreateCompatibleDC(nullptr);
  if (memory == nullptr) {
    if (errorOut != nullptr) *errorOut = "CreateCompatibleDC failed";
    return false;
  }
  HBITMAP bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (bitmap == nullptr || bits == nullptr) {
    DeleteDC(memory);
    if (errorOut != nullptr) *errorOut = "CreateDIBSection failed";
    return false;
  }
  HGDIOBJ previous = SelectObject(memory, bitmap);
  BOOL printed = PrintWindow(window, memory, kGdiWindowClassMask);
  if (!printed) {
    // PW_RENDERFULLCONTENT rejected: visible-pixel blit (occluders included).
    HDC screen = GetDC(nullptr);
    if (screen != nullptr) {
      BitBlt(memory, 0, 0, width, height, screen, rect.left, rect.top, SRCCOPY);
      ReleaseDC(nullptr, screen);
    }
  }
  out->width = width;
  out->height = height;
  out->originX = rect.left;
  out->originY = rect.top;
  out->bgra.resize(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
  std::memcpy(out->bgra.data(), bits, out->bgra.size());
  SelectObject(memory, previous);
  DeleteObject(bitmap);
  DeleteDC(memory);
  return true;
}

bool sampleColor(const PixelBuffer& buffer, LONG screenX, LONG screenY, std::string* color) {
  LONG localX = screenX - buffer.originX;
  LONG localY = screenY - buffer.originY;
  if (localX < 0 || localY < 0 || localX >= buffer.width || localY >= buffer.height) {
    *color = "#000000";  // CAPTURE_BLACK: the frame does not cover this point
    return false;
  }
  const unsigned char* pixel =
      buffer.bgra.data() + (static_cast<size_t>(localY) * static_cast<size_t>(buffer.width) + static_cast<size_t>(localX)) * 4;
  char rendered[8];
  std::snprintf(rendered, sizeof(rendered), "#%02x%02x%02x", pixel[2], pixel[1], pixel[0]);
  *color = rendered;
  return true;
}

const char* kBase64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const unsigned char* data, size_t size) {
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 3 <= size; i += 3) {
    unsigned int triple = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kBase64[(triple >> 18) & 0x3f]);
    out.push_back(kBase64[(triple >> 12) & 0x3f]);
    out.push_back(kBase64[(triple >> 6) & 0x3f]);
    out.push_back(kBase64[triple & 0x3f]);
  }
  size_t remaining = size - i;
  if (remaining == 1) {
    unsigned int value = data[i] << 16;
    out.push_back(kBase64[(value >> 18) & 0x3f]);
    out.push_back(kBase64[(value >> 12) & 0x3f]);
    out.push_back('=');
    out.push_back('=');
  } else if (remaining == 2) {
    unsigned int value = (data[i] << 16) | (data[i + 1] << 8);
    out.push_back(kBase64[(value >> 18) & 0x3f]);
    out.push_back(kBase64[(value >> 12) & 0x3f]);
    out.push_back(kBase64[(value >> 6) & 0x3f]);
    out.push_back('=');
  }
  return out;
}

bool pngEncode(const PixelBuffer& buffer, std::string* dataUrl, std::string* errorOut) {
  if (buffer.width <= 0 || buffer.height <= 0 || buffer.bgra.empty()) {
    if (errorOut != nullptr) *errorOut = "empty pixel buffer";
    return false;
  }
  UINT stride = static_cast<UINT>(buffer.width) * 4;
  UINT byteCount = stride * static_cast<UINT>(buffer.height);
  Microsoft::WRL::ComPtr<IWICBitmap> bitmap;
  HRESULT hr = g_wic->CreateBitmapFromMemory(buffer.width, buffer.height, GUID_WICPixelFormat32bppBGRA, stride,
                                             byteCount, const_cast<unsigned char*>(buffer.bgra.data()), &bitmap);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "CreateBitmapFromMemory failed: hr=" + hexHr(hr);
    return false;
  }

  Microsoft::WRL::ComPtr<IStream> heapStream;
  hr = CreateStreamOnHGlobal(nullptr, TRUE, &heapStream);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "CreateStreamOnHGlobal failed: hr=" + hexHr(hr);
    return false;
  }
  Microsoft::WRL::ComPtr<IWICStream> wicStream;
  hr = g_wic->CreateStream(&wicStream);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "WIC CreateStream failed: hr=" + hexHr(hr);
    return false;
  }
  hr = wicStream->InitializeFromIStream(heapStream.Get());
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "IWICStream::InitializeFromIStream failed: hr=" + hexHr(hr);
    return false;
  }

  Microsoft::WRL::ComPtr<IWICBitmapEncoder> encoder;
  hr = g_wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "PNG encoder CreateEncoder failed: hr=" + hexHr(hr);
    return false;
  }
  hr = encoder->Initialize(wicStream.Get(), WICBitmapEncoderNoCache);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "encoder Initialize failed: hr=" + hexHr(hr);
    return false;
  }
  Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame;
  hr = encoder->CreateNewFrame(&frame, nullptr);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "encoder CreateNewFrame failed: hr=" + hexHr(hr);
    return false;
  }
  hr = frame->Initialize(nullptr);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "frame Initialize failed: hr=" + hexHr(hr);
    return false;
  }
  frame->SetSize(buffer.width, buffer.height);
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  frame->SetPixelFormat(&format);
  hr = frame->WriteSource(bitmap.Get(), nullptr);
  if (FAILED(hr)) {
    if (errorOut != nullptr) *errorOut = "frame WriteSource failed: hr=" + hexHr(hr);
    return false;
  }
  frame->Commit();
  encoder->Commit();

  HGLOBAL global = nullptr;
  GetHGlobalFromStream(heapStream.Get(), &global);
  if (global == nullptr) {
    if (errorOut != nullptr) *errorOut = "encoded stream has no backing global";
    return false;
  }
  SIZE_T total = GlobalSize(global);
  const unsigned char* bytes = static_cast<const unsigned char*>(GlobalLock(global));
  if (bytes == nullptr) {
    if (errorOut != nullptr) *errorOut = "GlobalLock failed";
    return false;
  }
  *dataUrl = "data:image/png;base64," + base64Encode(bytes, total);
  GlobalUnlock(global);
  return true;
}

void fillShot(FrameShot* shot, const PixelBuffer& buffer, std::string* errorOut) {
  shot->originX = buffer.originX;
  shot->originY = buffer.originY;
  shot->width = buffer.width;
  shot->height = buffer.height;
  pngEncode(buffer, &shot->dataUrl, errorOut);
}

}  // namespace

bool captureRegions(HWND window, const std::vector<RegionSample>& samples, const std::string& mode,
                    CaptureResult* result, std::string* errorOut) {
  RECT rect{};
  if (window == nullptr || !GetWindowRect(window, &rect)) {
    if (errorOut != nullptr) *errorOut = "capture target is not a valid window";
    return false;
  }
  result->width = rect.right - rect.left;
  result->height = rect.bottom - rect.top;
  result->regions = Json::makeObject();

  std::string reason;
  bool useWgc = mode != "gdi";
  if (useWgc && !ensureCaptureReady(&reason)) {
    useWgc = false;  // automatic fallback to the GDI window blit
    result->fallbackReason = reason;
  }
  result->mode = useWgc ? "wgc" : "gdi";

  PixelBuffer windowBuffer;
  bool windowBufferReady = false;
  std::string windowError;
  PixelBuffer monitorBuffer;
  bool monitorBufferReady = false;
  HMONITOR monitorBufferOwner = nullptr;
  std::string monitorError;

  for (const RegionSample& sample : samples) {
    LONG screenX = 0;
    LONG screenY = 0;
    if (sample.windowSpace) {
      screenX = rect.left + static_cast<LONG>(std::llround(sample.x));
      screenY = rect.top + static_cast<LONG>(std::llround(sample.y));
    } else {
      screenX = static_cast<LONG>(std::llround(sample.x));
      screenY = static_cast<LONG>(std::llround(sample.y));
    }

    std::string color = "#000000";
    if (sample.windowSpace) {
      if (!windowBufferReady) {
        if (useWgc) {
          windowBufferReady = grabWindowWgcFrame(window, &windowBuffer, &windowError);
          if (!windowBufferReady) {
            result->mode = "gdi";  // the window frame fell back to the PrintWindow blit
            if (result->fallbackReason.empty()) result->fallbackReason = windowError;
          }
        }
        if (!windowBufferReady) windowBufferReady = grabWindowGdi(window, &windowBuffer, &windowError);
        if (!windowBufferReady) {
          if (errorOut != nullptr) *errorOut = "window frame capture failed: " + windowError;
          return false;
        }
      }
      sampleColor(windowBuffer, screenX, screenY, &color);
    } else {
      // Desktop samples stay on their own source: the WGC monitor frame keeps
      // working even when the window frame fell back to the GDI blit. An
      // explicitly forced `gdi` request (or a dead capture system) reports the
      // miss sentinel: a window blit has no desktop pixels.
      if (!useWgc) {
        color = "#000000";
        if (result->desktopSource.empty()) result->desktopSource = "none";
      } else {
        HMONITOR monitor = MonitorFromPoint({screenX, screenY}, MONITOR_DEFAULTTONEAREST);
        if (!monitorBufferReady || monitorBufferOwner != monitor) {
          monitorBufferReady = grabMonitorWgcFrame({screenX, screenY}, &monitorBuffer, &monitorError);
          monitorBufferOwner = monitor;
        }
        if (monitorBufferReady) {
          sampleColor(monitorBuffer, screenX, screenY, &color);
          result->desktopSource = "wgc";
        } else {
          color = "#000000";  // desktop frame unavailable: report the miss sentinel
          result->desktopSource = "none";
        }
      }
    }
    result->regions.set(sample.name, Json::makeString(color));
  }
  return true;
}

bool captureScreenshotFrames(HWND window, std::vector<FrameShot>* shots, std::string* usedMode, std::string* errorOut) {
  RECT rect{};
  if (window == nullptr || !GetWindowRect(window, &rect)) {
    if (errorOut != nullptr) *errorOut = "capture target is not a valid window";
    return false;
  }

  std::string reason;
  bool ready = ensureCaptureReady(&reason);
  PixelBuffer buffer;
  FrameShot windowShot;
  windowShot.id = "window";
  windowShot.zIndex = 0;
  std::string captureError;

  bool windowFromWgc = ready && grabWindowWgcFrame(window, &buffer, &captureError);
  *usedMode = windowFromWgc ? "wgc" : "gdi";
  if (!windowFromWgc) {
    std::string gdiError;
    if (!grabWindowGdi(window, &buffer, &gdiError)) {
      if (errorOut != nullptr) *errorOut = "window capture failed (WGC: " + captureError + "; GDI: " + gdiError + ")";
      return false;
    }
    captureError = gdiError;
  }
  fillShot(&windowShot, buffer, &captureError);
  if (windowShot.dataUrl.empty()) {
    if (errorOut != nullptr) *errorOut = "PNG encode failed: " + captureError;
    return false;
  }
  shots->push_back(windowShot);

  // Desktop-context shot rides the WGC monitor frame even when the window
  // frame itself fell back to the GDI blit.
  if (ready) {
    POINT center{(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2};
    PixelBuffer desktop;
    std::string desktopError;
    if (grabMonitorWgcFrame(center, &desktop, &desktopError)) {
      FrameShot desktopShot;
      desktopShot.id = "desktop";
      desktopShot.zIndex = 1;
      fillShot(&desktopShot, desktop, &desktopError);
      if (!desktopShot.dataUrl.empty()) shots->push_back(desktopShot);
    }
  }
  return true;
}

Json captureProbeResult(HWND window) {
  Json out = Json::makeObject();
  std::string reason;
  bool ready = ensureCaptureReady(&reason);
  out.set("wgcSupported", Json::makeBool(ready));
  out.set("driver", Json::makeString(g_usedWarp ? "warp" : "hardware"));
  out.set("adapter", Json::makeString(g_adapterName));
  if (!ready) {
    out.set("reason", Json::makeString(reason));
    return out;
  }

  if (window != nullptr) {
    RECT rect{};
    if (!GetWindowRect(window, &rect)) {
      out.set("freshFrameOk", Json::makeBool(false));
      out.set("frameError", Json::makeString("GetWindowRect failed"));
      return out;
    }
    out.set("rectWidth", Json::makeNumber(rect.right - rect.left));
    out.set("rectHeight", Json::makeNumber(rect.bottom - rect.top));

    // Binding diagnostics: does CreateForWindow hand back an item for THIS
    // window with a non-empty size?
    try {
      auto factory = winrt::get_activation_factory<Capture::GraphicsCaptureItem>();
      auto interop = factory.as<IGraphicsCaptureItemInterop>();
      Capture::GraphicsCaptureItem item{nullptr};
      HRESULT hr = interop->CreateForWindow(window, iidGraphicsCaptureItem(),
                                            reinterpret_cast<void**>(winrt::put_abi(item)));
      out.set("createHr", Json::makeString(hexHr(hr)));
      if (item != nullptr) {
        auto size = item.Size();
        out.set("itemWidth", Json::makeNumber(size.Width));
        out.set("itemHeight", Json::makeNumber(size.Height));
        Microsoft::WRL::ComPtr<IWindowGraphicsCaptureItemInterop> windowInterop;
        auto* inspectable = reinterpret_cast<::IInspectable*>(winrt::get_abi(item));
        if (inspectable != nullptr && SUCCEEDED(inspectable->QueryInterface(
                                           IID_PPV_ARGS(&windowInterop)))) {
          HWND bound = nullptr;
          if (SUCCEEDED(windowInterop->GetWindow(&bound))) {
            out.set("boundHwnd", Json::makeNumber(static_cast<double>(reinterpret_cast<UINT_PTR>(bound))));
            out.set("boundMatches", Json::makeBool(bound == window));
          }
        }
      }
    } catch (const winrt::hresult_error& error) {
      out.set("createError", Json::makeString(hexHr(error.code())));
    }

    auto existing = g_windowContexts.find(window);
    if (existing != g_windowContexts.end()) {
      existing->second.reset();
      g_windowContexts.erase(existing);
    }
    PixelBuffer buffer;
    std::string error;
    ULONGLONG started = GetTickCount64();
    bool ok = grabWindowWgcFrame(window, &buffer, &error, true);
    ULONGLONG elapsed = GetTickCount64() - started;
    out.set("freshFrameOk", Json::makeBool(ok));
    out.set("freshFrameMs", Json::makeNumber(static_cast<double>(elapsed)));
    if (ok) {
      out.set("frameWidth", Json::makeNumber(buffer.width));
      out.set("frameHeight", Json::makeNumber(buffer.height));
      out.set("originX", Json::makeNumber(buffer.originX));
      out.set("originY", Json::makeNumber(buffer.originY));
    } else {
      out.set("frameError", Json::makeString(error));
    }
    return out;
  }

  // Force a brand-new session and time its first delivered monitor frame.
  POINT origin{0, 0};
  HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  auto existingMonitor = g_monitorContexts.find(monitor);
  if (existingMonitor != g_monitorContexts.end()) {
    existingMonitor->second.reset();
    g_monitorContexts.erase(existingMonitor);
  }
  PixelBuffer buffer;
  std::string error;
  ULONGLONG started = GetTickCount64();
  bool ok = grabMonitorWgcFrame(origin, &buffer, &error);
  ULONGLONG elapsed = GetTickCount64() - started;
  out.set("freshFrameOk", Json::makeBool(ok));
  out.set("freshFrameMs", Json::makeNumber(static_cast<double>(elapsed)));
  if (ok) {
    out.set("frameWidth", Json::makeNumber(buffer.width));
    out.set("frameHeight", Json::makeNumber(buffer.height));
  } else {
    out.set("frameError", Json::makeString(error));
  }
  return out;
}

}  // namespace cua

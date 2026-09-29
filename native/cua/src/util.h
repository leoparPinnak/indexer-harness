// UTF-8 <-> UTF-16 helpers shared by the protocol, UIA, input, and capture code.
#pragma once

#include <cstdio>
#include <string>
#include <windows.h>

namespace cua {

inline std::wstring utf8ToWide(const std::string& text) {
  if (text.empty()) return std::wstring();
  int needed = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), needed);
  return out;
}

inline std::string wideToUtf8(const wchar_t* text, int length = -1) {
  if (text == nullptr || (length == 0)) return std::string();
  UINT codePage = CP_UTF8;
  int sourceLength = length;
  if (length < 0) sourceLength = static_cast<int>(wcslen(text));
  if (sourceLength == 0) return std::string();
  int needed = WideCharToMultiByte(codePage, 0, text, sourceLength, nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(codePage, 0, text, sourceLength, out.data(), needed, nullptr, nullptr);
  return out;
}

inline std::string wideToUtf8(const std::wstring& text) { return wideToUtf8(text.c_str(), static_cast<int>(text.size())); }

inline std::string trim(const std::string& text) {
  const char* spaces = " \t\r\n";
  size_t begin = text.find_first_not_of(spaces);
  if (begin == std::string::npos) return std::string();
  size_t end = text.find_last_not_of(spaces);
  return text.substr(begin, end - begin + 1);
}

// "0x%08lX" rendering of an HRESULT / Win32 error for error payloads.
inline std::string hexHr(long code) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(code));
  return std::string(buffer);
}

}  // namespace cua

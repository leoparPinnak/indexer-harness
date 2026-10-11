#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace cua {
namespace {

struct Parser {
  const std::string& text;
  size_t pos = 0;
  std::string error;

  explicit Parser(const std::string& t) : text(t) {}

  void skipWs() {
    while (pos < text.size() && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) ++pos;
  }

  bool fail(const std::string& message) {
    if (error.empty()) error = message + " at offset " + std::to_string(pos);
    return false;
  }

  bool parseValue(Json* out) {
    skipWs();
    if (pos >= text.size()) return fail("unexpected end of input");
    char c = text[pos];
    switch (c) {
      case '{': return parseObject(out);
      case '[': return parseArray(out);
      case '"': {
        std::string value;
        if (!parseString(&value)) return false;
        *out = Json::makeString(std::move(value));
        return true;
      }
      case 't':
        if (text.compare(pos, 4, "true") == 0) { pos += 4; *out = Json::makeBool(true); return true; }
        return fail("invalid literal");
      case 'f':
        if (text.compare(pos, 5, "false") == 0) { pos += 5; *out = Json::makeBool(false); return true; }
        return fail("invalid literal");
      case 'n':
        if (text.compare(pos, 4, "null") == 0) { pos += 4; *out = Json(); return true; }
        return fail("invalid literal");
      default: return parseNumber(out);
    }
  }

  bool parseObject(Json* out) {
    ++pos;  // '{'
    *out = Json::makeObject();
    skipWs();
    if (pos < text.size() && text[pos] == '}') { ++pos; return true; }
    while (true) {
      skipWs();
      if (pos >= text.size() || text[pos] != '"') return fail("expected object key");
      std::string key;
      if (!parseString(&key)) return false;
      skipWs();
      if (pos >= text.size() || text[pos] != ':') return fail("expected ':'");
      ++pos;
      Json value;
      if (!parseValue(&value)) return false;
      out->obj.emplace_back(std::move(key), std::move(value));
      skipWs();
      if (pos >= text.size()) return fail("unterminated object");
      if (text[pos] == ',') { ++pos; continue; }
      if (text[pos] == '}') { ++pos; return true; }
      return fail("expected ',' or '}'");
    }
  }

  bool parseArray(Json* out) {
    ++pos;  // '['
    *out = Json::makeArray();
    skipWs();
    if (pos < text.size() && text[pos] == ']') { ++pos; return true; }
    while (true) {
      Json value;
      if (!parseValue(&value)) return false;
      out->arr.push_back(std::move(value));
      skipWs();
      if (pos >= text.size()) return fail("unterminated array");
      if (text[pos] == ',') { ++pos; continue; }
      if (text[pos] == ']') { ++pos; return true; }
      return fail("expected ',' or ']'");
    }
  }

  static void appendUtf8(unsigned long codePoint, std::string* out) {
    if (codePoint <= 0x7F) {
      out->push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7FF) {
      out->push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
      out->push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else if (codePoint <= 0xFFFF) {
      out->push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
      out->push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else {
      out->push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
      out->push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    }
  }

  bool parseHex4(unsigned long* out) {
    if (pos + 4 > text.size()) return fail("truncated \\u escape");
    unsigned long value = 0;
    for (int i = 0; i < 4; ++i) {
      char c = text[pos + static_cast<size_t>(i)];
      value <<= 4;
      if (c >= '0' && c <= '9') value |= static_cast<unsigned long>(c - '0');
      else if (c >= 'a' && c <= 'f') value |= static_cast<unsigned long>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') value |= static_cast<unsigned long>(c - 'A' + 10);
      else return fail("bad hex digit in \\u escape");
    }
    pos += 4;
    *out = value;
    return true;
  }

  bool parseString(std::string* out) {
    ++pos;  // '"'
    out->clear();
    while (true) {
      if (pos >= text.size()) return fail("unterminated string");
      char c = text[pos];
      if (c == '"') { ++pos; return true; }
      if (c == '\\') {
        ++pos;
        if (pos >= text.size()) return fail("truncated escape");
        char esc = text[pos++];
        switch (esc) {
          case '"': out->push_back('"'); break;
          case '\\': out->push_back('\\'); break;
          case '/': out->push_back('/'); break;
          case 'b': out->push_back('\b'); break;
          case 'f': out->push_back('\f'); break;
          case 'n': out->push_back('\n'); break;
          case 'r': out->push_back('\r'); break;
          case 't': out->push_back('\t'); break;
          case 'u': {
            unsigned long codeUnit = 0;
            if (!parseHex4(&codeUnit)) return false;
            if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
              if (pos + 1 < text.size() && text[pos] == '\\' && text[pos + 1] == 'u') {
                pos += 2;
                unsigned long low = 0;
                if (!parseHex4(&low)) return false;
                if (low >= 0xDC00 && low <= 0xDFFF) {
                  codeUnit = 0x10000 + ((codeUnit - 0xD800) << 10) + (low - 0xDC00);
                } else {
                  return fail("invalid surrogate pair");
                }
              } else {
                return fail("lone high surrogate");
              }
            }
            appendUtf8(codeUnit, out);
            break;
          }
          default: return fail("bad escape character");
        }
        continue;
      }
      out->push_back(c);
      ++pos;
    }
  }

  bool parseNumber(Json* out) {
    size_t start = pos;
    if (pos < text.size() && text[pos] == '-') ++pos;
    while (pos < text.size() && (isdigit(static_cast<unsigned char>(text[pos])) || text[pos] == '.' ||
                                 text[pos] == 'e' || text[pos] == 'E' || text[pos] == '+' || text[pos] == '-'))
      ++pos;
    if (pos == start) return fail("expected value");
    std::string literal = text.substr(start, pos - start);
    char* end = nullptr;
    double value = strtod(literal.c_str(), &end);
    if (end == literal.c_str() || (end != nullptr && *end != '\0')) return fail("bad number literal");
    *out = Json::makeNumber(value);
    return true;
  }
};

void dumpString(const std::string& value, std::string* out) {
  out->push_back('"');
  for (unsigned char c : value) {
    switch (c) {
      case '"': out->append("\\\""); break;
      case '\\': out->append("\\\\"); break;
      case '\b': out->append("\\b"); break;
      case '\f': out->append("\\f"); break;
      case '\n': out->append("\\n"); break;
      case '\r': out->append("\\r"); break;
      case '\t': out->append("\\t"); break;
      default:
        if (c < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
          out->append(buffer);
        } else {
          out->push_back(static_cast<char>(c));
        }
    }
  }
  out->push_back('"');
}

void dumpNumber(double value, std::string* out) {
  if (std::isnan(value) || std::isinf(value)) { out->append("null"); return; }
  if (value == static_cast<long long>(value) && std::fabs(value) < 1e15) {
    out->append(std::to_string(static_cast<long long>(value)));
    return;
  }
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%.17g", value);
  out->append(buffer);
}

void dumpValue(const Json& value, std::string* out) {
  switch (value.type) {
    case Json::Type::Null: out->append("null"); break;
    case Json::Type::Bool: out->append(value.boolean ? "true" : "false"); break;
    case Json::Type::Number: dumpNumber(value.number, out); break;
    case Json::Type::String: dumpString(value.str, out); break;
    case Json::Type::Array: {
      out->push_back('[');
      for (size_t i = 0; i < value.arr.size(); ++i) {
        if (i > 0) out->push_back(',');
        dumpValue(value.arr[i], out);
      }
      out->push_back(']');
      break;
    }
    case Json::Type::Object: {
      out->push_back('{');
      for (size_t i = 0; i < value.obj.size(); ++i) {
        if (i > 0) out->push_back(',');
        dumpString(value.obj[i].first, out);
        out->push_back(':');
        dumpValue(value.obj[i].second, out);
      }
      out->push_back('}');
      break;
    }
  }
}

}  // namespace

Json Json::parse(const std::string& text, std::string* errorOut) {
  Parser parser(text);
  Json value;
  if (!parser.parseValue(&value)) {
    if (errorOut != nullptr) *errorOut = parser.error;
    return Json();
  }
  parser.skipWs();
  if (parser.pos != text.size()) {
    if (errorOut != nullptr) *errorOut = "trailing characters at offset " + std::to_string(parser.pos);
    return Json();
  }
  if (errorOut != nullptr) errorOut->clear();
  return value;
}

Json Json::makeString(std::string value) {
  Json j;
  j.type = Type::String;
  j.str = std::move(value);
  return j;
}

Json Json::makeNumber(double value) {
  Json j;
  j.type = Type::Number;
  j.number = value;
  return j;
}

Json Json::makeBool(bool value) {
  Json j;
  j.type = Type::Bool;
  j.boolean = value;
  return j;
}

Json Json::makeArray() {
  Json j;
  j.type = Type::Array;
  return j;
}

Json Json::makeObject() {
  Json j;
  j.type = Type::Object;
  return j;
}

const Json* Json::find(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (const auto& entry : obj) {
    if (entry.first == key) return &entry.second;
  }
  return nullptr;
}

std::string Json::getString(const std::string& key, const std::string& fallback) const {
  const Json* value = find(key);
  if (value == nullptr || value->type != Type::String) return fallback;
  return value->str;
}

double Json::getNumber(const std::string& key, double fallback) const {
  const Json* value = find(key);
  if (value == nullptr || value->type != Type::Number) return fallback;
  return value->number;
}

bool Json::getBool(const std::string& key, bool fallback) const {
  const Json* value = find(key);
  if (value == nullptr || value->type != Type::Bool) return fallback;
  return value->boolean;
}

void Json::set(const std::string& key, Json value) {
  if (type != Type::Object) *this = makeObject();
  for (auto& entry : obj) {
    if (entry.first == key) { entry.second = std::move(value); return; }
  }
  obj.emplace_back(key, std::move(value));
}

void Json::push(Json value) {
  if (type != Type::Array) *this = makeArray();
  arr.push_back(std::move(value));
}

std::string Json::dump() const {
  std::string out;
  dumpValue(*this, &out);
  return out;
}

}  // namespace cua

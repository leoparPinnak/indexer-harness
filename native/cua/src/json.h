// Minimal ordered JSON value + parser/serializer for the stdio NDJSON protocol.
// UTF-8 std::string on the wire; wide conversions live in util.h.
#pragma once

#include <string>
#include <utility>
#include <vector>

namespace cua {

struct Json {
  enum class Type { Null, Bool, Number, String, Array, Object };

  Type type = Type::Null;
  bool boolean = false;
  double number = 0;
  std::string str;
  std::vector<Json> arr;
  std::vector<std::pair<std::string, Json>> obj;

  static Json parse(const std::string& text, std::string* errorOut);
  static Json makeString(std::string value);
  static Json makeNumber(double value);
  static Json makeBool(bool value);
  static Json makeArray();
  static Json makeObject();

  bool isNull() const { return type == Type::Null; }
  bool isObject() const { return type == Type::Object; }
  bool isArray() const { return type == Type::Array; }
  bool isString() const { return type == Type::String; }
  bool isNumber() const { return type == Type::Number; }

  const Json* find(const std::string& key) const;
  std::string getString(const std::string& key, const std::string& fallback = std::string()) const;
  double getNumber(const std::string& key, double fallback = 0) const;
  bool getBool(const std::string& key, bool fallback = false) const;

  void set(const std::string& key, Json value);
  void push(Json value);
  std::string dump() const;
};

}  // namespace cua

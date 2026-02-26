/**
 * @file opcua-data-converter.js
 * @description Centralized data type conversion for OPC UA values.
 *
 * Handles all bidirectional mapping between JavaScript values and OPC UA typed
 * Variants / DataValues.  Used by the Item, Client, and Method nodes when
 * reading, writing, and subscribing.
 *
 * ─── Design goals ──────────────────────────────────────────────────────────────
 *  • Single, well-tested module for every data-type coercion in the library.
 *  • Support for all scalar types, array types, ExtensionObjects, and Int64/UInt64.
 *  • Clear, readable switch-based logic (no nested ternaries).
 *  • Explicit typed-array construction for array values.
 */

"use strict";

const opcua = require("node-opcua");

// ── Typed-array constructor lookup ─────────────────────────────────────────────

const TYPED_ARRAY_MAP = {
  SByte:   Int8Array,
  Int8:    Int8Array,
  Byte:    Uint8Array,
  UInt8:   Uint8Array,
  Int16:   Int16Array,
  UInt16:  Uint16Array,
  Int32:   Int32Array,
  UInt32:  Uint32Array,
  Float:   Float32Array,
  Double:  Float64Array,
};

// ── NodeId-to-type-name mapping (ns=0 built-in types) ──────────────────────────

const NODEID_TYPE_MAP = {
  "ns=0;i=1":  "Boolean",
  "ns=0;i=2":  "SByte",
  "ns=0;i=3":  "Byte",
  "ns=0;i=4":  "Int16",
  "ns=0;i=5":  "UInt16",
  "ns=0;i=6":  "Int32",
  "ns=0;i=7":  "UInt32",
  "ns=0;i=8":  "Int64",
  "ns=0;i=9":  "UInt64",
  "ns=0;i=10": "Float",
  "ns=0;i=11": "Double",
  "ns=0;i=12": "String",
  "ns=0;i=13": "DateTime",
  "ns=0;i=14": "Guid",
  "ns=0;i=15": "ByteString",
  "ns=0;i=16": "XmlElement",
  "ns=0;i=17": "NodeId",
  "ns=0;i=18": "ExpandedNodeId",
  "ns=0;i=19": "StatusCode",
  "ns=0;i=20": "QualifiedName",
  "ns=0;i=21": "LocalizedText",
  "ns=0;i=22": "ExtensionObject",
  "ns=0;i=23": "DataValue",
  "ns=0;i=24": "BaseDataType",
  "ns=0;i=25": "DiagnosticInfo",
  "ns=0;i=26": "Number",
  "ns=0;i=27": "Integer",
  "ns=0;i=28": "UInteger",
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Resolve a NodeId string like "ns=0;i=11" to a human-readable type name.
 *
 * @param {string} nodeIdStr - OPC UA NodeId string.
 * @returns {string} Human-readable type name, or the original string if unknown.
 */
function resolveTypeName(nodeIdStr) {
  return NODEID_TYPE_MAP[nodeIdStr] || nodeIdStr;
}

/**
 * Map a data-type name string to the corresponding `opcua.DataType` enum value.
 *
 * @param {string} datatype - Type name (e.g. "Double", "Int32", "Boolean").
 * @returns {opcua.DataType}
 */
function toOpcuaDataType(datatype) {
  if (!datatype) return opcua.DataType.Null;

  // Strip " Array" suffix for type resolution
  const baseType = datatype.replace(/\s*Array$/i, "").trim();

  const typeMap = {
    Boolean:       opcua.DataType.Boolean,
    SByte:         opcua.DataType.SByte,
    Int8:          opcua.DataType.SByte,
    Byte:          opcua.DataType.Byte,
    UInt8:         opcua.DataType.Byte,
    Int16:         opcua.DataType.Int16,
    UInt16:        opcua.DataType.UInt16,
    Int32:         opcua.DataType.Int32,
    UInt32:        opcua.DataType.UInt32,
    Int64:         opcua.DataType.Int64,
    UInt64:        opcua.DataType.UInt64,
    Float:         opcua.DataType.Float,
    Double:        opcua.DataType.Double,
    String:        opcua.DataType.String,
    DateTime:      opcua.DataType.DateTime,
    Guid:          opcua.DataType.Guid,
    ByteString:    opcua.DataType.ByteString,
    XmlElement:    opcua.DataType.XmlElement,
    NodeId:        opcua.DataType.NodeId,
    LocalizedText: opcua.DataType.LocalizedText,
    QualifiedName: opcua.DataType.QualifiedName,
    ExtensionObject: opcua.DataType.ExtensionObject,
  };

  return typeMap[baseType] || opcua.DataType.Null;
}

/**
 * Detect whether a data-type string represents an array type.
 *
 * @param {string} datatype - Type name (e.g. "Int32 Array", "Double").
 * @returns {boolean}
 */
function isArrayType(datatype) {
  return /Array$/i.test(datatype);
}

// ── Scalar coercion ────────────────────────────────────────────────────────────

/**
 * Coerce a raw JavaScript value into the proper type for a given OPC UA scalar.
 *
 * @param {string} datatype - The OPC UA data-type name.
 * @param {*}      value    - The raw value to coerce.
 * @returns {*} The coerced value.
 */
function coerceScalarValue(datatype, value) {
  const baseType = datatype.replace(/\s*Array$/i, "").trim();

  switch (baseType) {
    case "Boolean":
      return coerceBoolean(value);

    case "Int8":
    case "SByte":
      return clampInt(Number(value), -128, 127);

    case "Byte":
    case "UInt8":
      return clampInt(Number(value), 0, 255);

    case "Int16":
      return clampInt(Number(value), -32768, 32767);

    case "UInt16":
      return clampInt(Number(value), 0, 65535);

    case "Int32":
      return clampInt(Number(value), -2147483648, 2147483647);

    case "UInt32":
      return clampInt(Number(value), 0, 4294967295);

    case "Int64":
      return coerceInt64(value);

    case "UInt64":
      return coerceUInt64(value);

    case "Float":
      return parseFloat(value);

    case "Double":
      return parseFloat(value);

    case "String":
      return String(value);

    case "DateTime":
      return coerceDateTime(value);

    case "ByteString":
      return coerceByteString(value);

    case "LocalizedText":
      return opcua.coerceLocalizedText(value);

    case "NodeId":
      return opcua.coerceNodeId(value);

    case "QualifiedName":
      return typeof value === "string" ? { name: value } : value;

    case "ExtensionObject":
      return coerceExtensionObject(value);

    default:
      return value;
  }
}

// ── Array coercion ─────────────────────────────────────────────────────────────

/**
 * Coerce a value into a properly typed array for a given OPC UA array data type.
 *
 * Accepts:
 *  - A comma-separated string: "1,2,3"
 *  - A JavaScript Array: [1, 2, 3]
 *  - An existing TypedArray (passed through)
 *
 * @param {string}             datatype - The base data-type name (e.g. "Int32").
 * @param {string|Array|*}     value    - The raw value(s).
 * @returns {TypedArray|Array}
 */
function coerceArrayValue(datatype, value) {
  const baseType = datatype.replace(/\s*Array$/i, "").trim();

  // Parse comma-separated strings into arrays
  const items = parseToArray(value);

  // For numeric types, use typed arrays for performance
  const TypedArrayCtor = TYPED_ARRAY_MAP[baseType];
  if (TypedArrayCtor) {
    return TypedArrayCtor.from(items, (item) => Number(item));
  }

  // Boolean arrays
  if (baseType === "Boolean") {
    return items.map((item) => coerceBoolean(item));
  }

  // String arrays
  if (baseType === "String") {
    return items.map((item) => String(item));
  }

  // ExtensionObject arrays
  if (baseType === "ExtensionObject") {
    return items.map((item) => coerceExtensionObject(item));
  }

  // Variant arrays (recursive)
  if (baseType === "Variant") {
    return items.map((item) => {
      if (item && item.dataType) {
        return new opcua.Variant({
          dataType: toOpcuaDataType(item.dataType),
          value: coerceScalarValue(item.dataType, item.value),
        });
      }
      return item;
    });
  }

  // Fallback — return the raw array
  return items;
}

// ── Variant builders ───────────────────────────────────────────────────────────

/**
 * Build an `opcua.Variant` from a data-type name and raw value.
 *
 * Automatically chooses scalar vs. array variant based on the data-type string.
 *
 * @param {string} datatype - The OPC UA data-type name (e.g. "Double", "Int32 Array").
 * @param {*}      value    - The raw value.
 * @returns {opcua.Variant}
 */
function buildVariant(datatype, value) {
  if (!datatype) {
    return new opcua.Variant({ dataType: opcua.DataType.Null, value: null });
  }

  const opcuaType = toOpcuaDataType(datatype);

  if (isArrayType(datatype)) {
    return new opcua.Variant({
      dataType: opcuaType,
      arrayType: opcua.VariantArrayType.Array,
      value: coerceArrayValue(datatype, value),
    });
  }

  return new opcua.Variant({
    dataType: opcuaType,
    value: coerceScalarValue(datatype, value),
  });
}

/**
 * Build an `opcua.DataValue` for a write operation.
 *
 * @param {string}  datatype        - The OPC UA data-type name.
 * @param {*}       value           - The raw value.
 * @param {Date}    [sourceTimestamp] - Optional source timestamp.
 * @param {number}  [statusCode]    - Optional status code value.
 * @returns {opcua.DataValue}
 */
function buildDataValue(datatype, value, sourceTimestamp, statusCode) {
  const variant = buildVariant(datatype, value);

  const dvOptions = { value: variant };

  if (sourceTimestamp) {
    dvOptions.sourceTimestamp = new Date(sourceTimestamp);
  }
  if (statusCode !== undefined && statusCode !== null) {
    dvOptions.statusCode = statusCode;
  }

  return new opcua.DataValue(dvOptions);
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Clamp an integer value within [min, max].
 */
function clampInt(value, min, max) {
  const num = Math.round(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(min, Math.min(max, num));
}

/**
 * Coerce a value to boolean (handles strings "true"/"false", numbers 0/1).
 */
function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  return Boolean(value);
}

/**
 * Coerce a value to an Int64 representation.
 * node-opcua represents Int64 as [high, low] two-element arrays.
 */
function coerceInt64(value) {
  if (Array.isArray(value) && value.length === 2) return value;
  return [0, parseInt(value, 10) || 0];
}

/**
 * Coerce a value to a UInt64 representation.
 */
function coerceUInt64(value) {
  if (Array.isArray(value) && value.length === 2) return value;
  const num = parseInt(value, 10) || 0;
  return [Math.floor(num / 4294967296), num >>> 0];
}

/**
 * Coerce a value to a Date object.
 */
function coerceDateTime(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return new Date();
}

/**
 * Coerce a value to a Buffer (ByteString).
 */
function coerceByteString(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.from(String(value));
}

/**
 * Coerce a value to an ExtensionObject (parse JSON strings).
 */
function coerceExtensionObject(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Parse a value into an array.
 * - Arrays pass through.
 * - Comma-separated strings are split.
 * - Single values are wrapped.
 */
function parseToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.includes(",")) {
    return value.split(",").map((s) => s.trim());
  }
  return [value];
}

// ── Subscription parameter helpers ─────────────────────────────────────────────

/**
 * Build subscription parameters for data monitoring.
 *
 * @param {number} publishingInterval - Publishing interval in milliseconds.
 * @returns {object} Subscription options for `ClientSubscription.create()`.
 */
function buildSubscriptionParameters(publishingInterval) {
  return {
    requestedPublishingInterval: publishingInterval,
    requestedLifetimeCount: 60,
    requestedMaxKeepAliveCount: 10,
    maxNotificationsPerPublish: 10,
    publishingEnabled: true,
    priority: 10,
  };
}

/**
 * Build subscription parameters optimized for event monitoring.
 *
 * @param {number} publishingInterval - Publishing interval in milliseconds.
 * @returns {object} Subscription options for `ClientSubscription.create()`.
 */
function buildEventSubscriptionParameters(publishingInterval) {
  return {
    requestedPublishingInterval: publishingInterval,
    requestedLifetimeCount: 120,
    requestedMaxKeepAliveCount: 3,
    maxNotificationsPerPublish: 4,
    publishingEnabled: true,
    priority: 1,
  };
}

// ── Time conversion ────────────────────────────────────────────────────────────

/**
 * Convert a time value and unit string to milliseconds.
 *
 * @param {number} time - The numeric time value.
 * @param {string} unit - Unit: "ms", "s", "m", or "h".
 * @returns {number} Time in milliseconds.
 */
function toMilliseconds(time, unit) {
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return time * (multipliers[unit] || 1000);
}

/**
 * Get a human-readable label for a time unit.
 *
 * @param {string} unit - Unit code.
 * @returns {string}
 */
function getTimeUnitLabel(unit) {
  const labels = { ms: "millisecond(s)", s: "second(s)", m: "minute(s)", h: "hour(s)" };
  return labels[unit] || unit;
}

module.exports = {
  // Type resolution
  resolveTypeName,
  toOpcuaDataType,
  isArrayType,

  // Value coercion
  coerceScalarValue,
  coerceArrayValue,

  // Variant / DataValue building
  buildVariant,
  buildDataValue,

  // Subscription helpers
  buildSubscriptionParameters,
  buildEventSubscriptionParameters,

  // Time helpers
  toMilliseconds,
  getTimeUnitLabel,
};

/**
 * @file opcua-item.js
 * @description OPC UA Item node — prepares item metadata for downstream nodes.
 *
 * This node sits before the OPC UA Client node and enriches `msg` with:
 *   - `msg.topic`      — the OPC UA NodeId address
 *   - `msg.datatype`   — the OPC UA data type name
 *   - `msg.browseName` — human-readable display name
 *   - `msg.payload`    — the value (coerced to the correct type)
 *
 * If the node has a static value configured AND `msg.payload` is empty,
 * the static value is used. Otherwise `msg.payload` flows through.
 */

"use strict";

const { coerceScalarValue, isArrayType, coerceArrayValue } = require("../lib/opcua-data-converter");

module.exports = function (RED) {
  /**
   * OpcUaItemNode constructor.
   *
   * @param {object} config - Node configuration from the editor.
   */
  function OpcUaItemNode(config) {
    RED.nodes.createNode(this, config);

    // ── Configuration ────────────────────────────────────────────────────
    this.item     = config.item     || "";   // NodeId address
    this.datatype = (config.datatype || "").trim();
    this.value    = config.value;            // Static default value (may be null)
    this.name     = config.name     || "";   // Browse / display name

    const node = this;

    // ── Input handler ────────────────────────────────────────────────────
    this.on("input", (msg, send, done) => {
      // Always set item metadata on the msg
      msg.topic     = node.item;
      msg.datatype  = node.datatype || msg.datatype || "";
      msg.browseName = node.name;

      // Determine the effective data type
      const effectiveType = msg.datatype;

      // Determine the raw value to coerce
      const hasPayload = msg.payload !== undefined && msg.payload !== null && msg.payload !== "";
      const hasStaticValue = node.value !== undefined && node.value !== null && node.value !== "";

      if (hasPayload) {
        // Dynamic value from incoming msg
        msg.payload = coerceValue(effectiveType, msg.payload);
      } else if (hasStaticValue) {
        // Static value from node configuration
        msg.payload = coerceValue(effectiveType, node.value);
      }
      // If neither, msg.payload passes through as-is (for read operations)

      send(msg);
      done();
    });
  }

  RED.nodes.registerType("opcua-item", OpcUaItemNode);
};

// ── Helpers ──────────────────────────────────────────────────────────────────────

/**
 * Coerce a value using the appropriate scalar or array converter.
 *
 * @param {string} datatype - The OPC UA data type name.
 * @param {*}      value    - The raw value.
 * @returns {*} The coerced value.
 */
function coerceValue(datatype, value) {
  if (!datatype) return value;

  if (isArrayType(datatype)) {
    return coerceArrayValue(datatype, value);
  }
  return coerceScalarValue(datatype, value);
}

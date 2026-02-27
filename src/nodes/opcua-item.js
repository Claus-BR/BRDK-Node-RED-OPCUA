/**
 * @file opcua-item.js
 * @description OPC UA Item node — prepares item metadata for downstream nodes.
 *
 * This node sits before the OPC UA Client node and enriches `msg` with:
 *   - `msg.items`  — always an array of one item: `[{ nodeId, datatype, browseName, value? }]`
 *   - `msg.topic`  — the OPC UA NodeId address (for display / downstream compat)
 *
 * If the node has a static value configured, it is coerced and included
 * as the item's `value`. Otherwise `value` is omitted (read-only use).
 * For dynamic writes, set `msg.items[0].value` via a Function node upstream.
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
      const effectiveType = node.datatype || msg.datatype || "";

      // Build the item object
      const item = {
        nodeId:     node.item,
        datatype:   effectiveType,
        browseName: node.name,
      };

      // Include static value if configured (for write operations)
      const hasStaticValue = node.value !== undefined && node.value !== null && node.value !== "";
      if (hasStaticValue) {
        item.value = coerceValue(effectiveType, node.value);
      }

      // Always output items as an array
      msg.items = [item];
      msg.topic = node.item;

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

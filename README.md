# @brdk/node-red-opcua

A clean, modern Node-RED OPC UA library built on [node-opcua](https://github.com/node-opcua/node-opcua).

## Features

- **OPC UA Client** — Read, write, subscribe, browse, monitor, history, file transfer, method calls, and more (20 actions)
- **OPC UA Server** — Full-featured OPC UA server with dynamic address space, alarms, historian, file transfer, and method support
- **OPC UA Browser** — One-shot address space exploration with enriched results
- **OPC UA Method** — Dedicated method call node with argument configuration
- **OPC UA Event** — Event subscription metadata preparation
- **OPC UA Discovery** — Local Discovery Server (LDS) on port 4840
- **OPC UA Rights** — Access level, role, and permission configuration
- **OPC UA Item** — Item metadata preparation (NodeId, data type, value)
- **OPC UA Endpoint** — Shared endpoint configuration (URL, security, authentication)

## Requirements

- Node.js >= 18.0.0
- Node-RED >= 2.0.0

## Installation

```bash
cd ~/.node-red
npm install <path-to-this-folder>
```

Or link for development:

```bash
cd ~/.node-red
npm link <path-to-this-folder>
```

## Node Types

### opcua-endpoint (config node)

Shared connection configuration:
- Endpoint URL (`opc.tcp://...`)
- Security policy (None, Basic128Rsa15, Basic256, Basic256Sha256, etc.)
- Security mode (None, Sign, SignAndEncrypt)
- Authentication: Anonymous, Username/Password, or Certificate

### opcua-item

Prepares OPC UA item metadata on `msg`:
- `msg.items` — always an array: `[{ nodeId, datatype, browseName, value? }]`
- `msg.topic` — NodeId (for display)

### opcua-client

Main client node with 20 actions:

| Action | Description |
|--------|-------------|
| `read` | Read one or more node values from `msg.items` |
| `write` | Write values from `msg.items` (each item must have a `value`) |
| `subscribe` | Create monitored subscriptions for items in `msg.items` |
| `monitor` | Subscribe with deadband filtering |
| `unsubscribe` | Remove a single monitored item |
| `deletesubscription` | Delete the entire subscription |
| `browse` | Browse using NodeCrawler |
| `events` | Subscribe to OPC UA events |
| `acknowledge` | Acknowledge an alarm/condition |
| `info` | Get session/subscription diagnostics |
| `build` | Construct an ExtensionObject |
| `history` | Read raw historical data |
| `readfile` | Read a file from the server (OPC UA File Transfer) |
| `writefile` | Write a file to the server |
| `method` | Call an OPC UA method |
| `register` | Register nodes for optimized access |
| `unregister` | Unregister previously registered nodes |
| `connect` | Manually connect to the server |
| `disconnect` | Manually disconnect |
| `reconnect` | Force reconnection |

### opcua-browser

Standalone browse node — creates a temporary connection, browses the address space, reads Value and DataType for each reference, and returns enriched results.

### opcua-event

Message enrichment node — sets `msg.topic` (source NodeId) and `msg.eventTypeIds` for use with the Client node's `events` action. Supports standard event types or custom NodeIds.

### opcua-method

Dedicated method call node with up to 3 configured input arguments and 1 output argument. Supports ExtensionObject construction. Arguments can be overridden by `msg` properties.

### opcua-discovery

Starts a Local Discovery Server on port 4840. OPC UA servers register themselves here. Send any message to list all registered server discovery URLs.

### opcua-server

Full-featured OPC UA server node with dynamic address space management.

**Configuration tabs:**
- **General** — Port (env: `SERVER_PORT`), endpoint path, users file, nodeset directory, auto-accept certificates, discovery registration, default address space, anonymous access
- **Security** — Security modes (None, Sign, Sign & Encrypt) and policies (Basic128Rsa15, Basic256, Basic256Sha256)
- **Limits** — 12 operation limits (browse, read, write, method call, monitored items, etc.)
- **Transport** — Max connections, message size, buffer size, sessions

**Commands via `msg.payload.opcuaCommand`:**

| Command | Description |
|---------|-------------|
| `restartOPCUAServer` | Graceful restart |
| `addVariable` | Add a variable (topic: `ns=1;s=Name;datatype=Double`) |
| `addFolder` | Add a folder under current parent |
| `setFolder` | Set active parent folder (topic: NodeId) |
| `deleteNode` | Delete a node (payload.nodeId) |
| `addEquipment` | Add an equipment object |
| `addPhysicalAsset` | Add a physical asset object |
| `addMethod` | Add a method with N input/output arguments |
| `bindMethod` | Bind a function to an existing method |
| `installHistorian` | Enable history on a variable |
| `installDiscreteAlarm` | Add a boolean alarm with severity |
| `installLimitAlarm` | Add HH/H/L/LL non-exclusive limit alarm |
| `addExtensionObject` | Add an extension object variable |
| `addFile` | Add a file node (OPC UA File Transfer) |
| `registerNamespace` | Register a new namespace URI |
| `getNamespaceIndex` | Get index of a namespace |
| `getNamespaces` | List all namespaces |
| `setUsers` | Update user credentials at runtime |
| `saveAddressSpace` | Save address space to XML |
| `loadAddressSpace` | Load address space from XML (triggers restart) |
| `bindVariables` | Bind get/set callbacks to all variables |

**Variable updates via `msg.payload`:**
```json
{
  "messageType": "Variable",
  "namespace": 1,
  "variableName": "MyVar",
  "variableValue": 42.0,
  "datatype": "Double",
  "quality": "Good",
  "sourceTimestamp": "2024-01-01T00:00:00Z"
}
```

**Session events output:** Client connect/disconnect and variable write notifications.

### opcua-rights

Access level and permission configuration node. Builds `msg.accessLevel`, `msg.userAccessLevel`, and `msg.permissions` from checkboxes. Supports chaining for multi-role setups.

## Architecture

### Message Data Structures

All data actions (`read`, `write`, `subscribe`, `monitor`) use a unified `msg.items` array to describe which OPC UA nodes to operate on. This is the core contract between item nodes and the client node.

#### `msg.items` — Item Array (Input to Client)

Produced by `opcua-item` and `opcua-smart-item` nodes. Always an array, even for a single item.

```json
{
  "items": [
    {
      "nodeId": "ns=2;s=Temperature",
      "datatype": "Double",
      "browseName": "Temperature",
      "value": 42.5
    }
  ],
  "topic": "ns=2;s=Temperature"
}
```

| Property     | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `nodeId`     | `string` | Yes      | OPC UA NodeId (e.g. `ns=2;s=MyVar`, `i=2258`) |
| `datatype`   | `string` | Yes      | OPC UA data type name (e.g. `Double`, `String`, `Boolean`) |
| `browseName` | `string` | No       | Human-readable display name |
| `value`      | `any`    | Write only | The value to write. Omitted for read/subscribe operations. |
| `timestamp`  | `Date`   | No       | Optional source timestamp for writes |

`msg.topic` is set to the first item's `nodeId` for convenience and debug display. The client node does **not** read `msg.topic` for data actions — it exclusively uses `msg.items`.

#### Per-Item Output (Client Output 1)

After a `read`, `subscribe`, or `monitor` action, the client sends one message per item on output 1. The `items` array is **not** carried forward.

```json
{
  "topic": "ns=2;s=Temperature",
  "datatype": "Double",
  "browseName": "Temperature",
  "payload": 23.5,
  "statusCode": { "value": 0, "description": "Good" },
  "sourceTimestamp": "2026-02-27T10:00:00.000Z",
  "serverTimestamp": "2026-02-27T10:00:01.000Z"
}
```

| Property           | Type     | Description |
|-------------------|----------|-------------|
| `topic`            | `string` | NodeId of the item |
| `datatype`         | `string` | OPC UA data type name |
| `browseName`       | `string` | Display name |
| `payload`          | `any`    | The read/changed value from the server |
| `statusCode`       | `object` | OPC UA StatusCode for the operation |
| `sourceTimestamp`   | `Date`   | When the source produced the value |
| `serverTimestamp`   | `Date`   | When the server recorded the value |

For **write** actions, output 1 carries `msg.payload` as an array of StatusCode(s) — one per written item.

#### Batch Output (Client Output 3)

For `read` actions, output 3 sends a single message with all results combined:

```json
{
  "topic": "read",
  "items": [
    {
      "nodeId": "ns=2;s=Temperature",
      "datatype": "Double",
      "browseName": "Temperature",
      "value": 23.5,
      "statusCode": { "value": 0 },
      "sourceTimestamp": "2026-02-27T10:00:00.000Z",
      "serverTimestamp": "2026-02-27T10:00:01.000Z"
    },
    {
      "nodeId": "ns=2;s=Pressure",
      "datatype": "Float",
      "browseName": "Pressure",
      "value": 1.013,
      "statusCode": { "value": 0 },
      "sourceTimestamp": "2026-02-27T10:00:00.000Z",
      "serverTimestamp": "2026-02-27T10:00:01.000Z"
    }
  ],
  "payload": [ /* raw DataValue array from node-opcua */ ]
}
```

#### Status Output (Client Output 2)

All actions emit status notifications on output 2:

```json
{
  "payload": "reading",
  "status": "reading",
  "error": null,
  "endpoint": "opc.tcp://localhost:4840"
}
```

### Message Flow

```
┌──────────┐     msg.items = [{nodeId, datatype, ...}]     ┌─────────────┐
│ opcua-   │ ──────────────────────────────────────────────► │ opcua-      │
│ item     │     msg.topic = "ns=2;s=Temp"                  │ client      │
│ (or      │                                                │             │──► Output 1: per-item results
│ smart-   │                                                │ action:     │──► Output 2: status
│ item)    │                                                │ read/write/ │──► Output 3: batch results
└──────────┘                                                │ subscribe   │
                                                            └─────────────┘
```

```
src/
├── lib/
│   ├── opcua-certificate-manager.js  # Singleton PKI certificate managers
│   ├── opcua-connection.js           # User identity & security resolution
│   ├── opcua-data-converter.js       # Data type conversion (JS ↔ OPC UA)
│   └── opcua-status.js               # Centralized node status definitions
└── nodes/
    ├── opcua-endpoint.js/.html       # Config node
    ├── opcua-item.js/.html           # Item metadata
    ├── opcua-client.js/.html         # Main client (20 actions)
    ├── opcua-browser.js/.html        # Address space browser
    ├── opcua-event.js/.html          # Event metadata
    ├── opcua-method.js/.html         # Method calls
    ├── opcua-discovery.js/.html      # Discovery server
    ├── opcua-server.js/.html         # OPC UA Server (21 commands)
    └── opcua-rights.js/.html         # Access rights
```

## License

Apache-2.0

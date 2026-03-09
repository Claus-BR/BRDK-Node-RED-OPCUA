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

Full-featured OPC UA server node with dynamic address space management via input messages.

#### Configuration

The server node has four configuration tabs in the Node-RED editor:

**General Tab**

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 4840 | TCP port for the server (override with `SERVER_PORT` env var) |
| Endpoint | *(empty)* | Resource path appended to URL (e.g. `UA/NodeREDServer`) |
| Users File | *(empty)* | Path to a JSON file with user credentials |
| Nodeset Dir | *(empty)* | Directory containing custom nodeset XML files |
| Auto Accept Certificates | true | Automatically trust unknown client certificates |
| Register to Discovery | false | Register this server with a Local Discovery Server |
| Construct Default Address Space | true | Create the default VendorName/Equipment/PhysicalAssets structure |
| Allow Anonymous | true | Allow connections without credentials |

**Security Tab**

| Security Modes | Default |
|----------------|---------|
| None | enabled |
| Sign | enabled |
| Sign & Encrypt | enabled |

| Security Policies | Default |
|-------------------|---------|
| Basic128Rsa15 | enabled |
| Basic256 | enabled |
| Basic256Sha256 | enabled |

**Limits Tab** — 12 operation limits (all default to 0 = unlimited):
`maxNodesPerBrowse`, `maxNodesPerRead`, `maxNodesPerWrite`, `maxNodesPerMethodCall`, `maxMonitoredItemsPerCall`, `maxNodesPerRegisterNodes`, `maxNodesPerNodeManagement`, `maxNodesPerHistoryReadData`, `maxNodesPerHistoryReadEvents`, `maxNodesPerHistoryUpdateData`, `maxNodesPerHistoryUpdateEvents`, `maxNodesPerTranslateBrowsePathsToNodeIds`

**Transport Tab**

| Setting | Default | Min |
|---------|---------|-----|
| Max Connections Per Endpoint | 20 | 1 |
| Max Message Size | 4096 | 1024 |
| Max Buffer Size | 4096 | 1024 |
| Max Sessions | 20 | 10 |

#### Understanding OPC UA Namespaces

Namespaces are URI-based ID pools — **not** folders. Every NodeId has a namespace index (`ns=`) that identifies which pool it belongs to:

| Index | URI | Source |
|-------|-----|--------|
| 0 | `http://opcfoundation.org/UA/` | Standard OPC UA (always present) |
| 1 | `urn:<hostname>:NodeOPCUA-Server` | **Your server's own namespace** |
| 2+ | *(varies)* | Additional loaded nodesets (DI, AutoID, etc.) |

**Rules:**
- Use `ns=1` for all custom nodes you create — this is the standard practice
- You can omit `ns=` — it defaults to `ns=1` (e.g. `s=Temperature` = `ns=1;s=Temperature`)
- Higher namespace indices only exist if those nodesets are loaded
- Use `registerNamespace` to create additional namespaces
- **The namespace has nothing to do with the folder structure** — a node's location in the tree is determined by its parent, not its namespace

#### Node Placement (Address Space Tree)

Where a node sits in the address space is determined by the **parent**, not the namespace:

```
Objects
 └─ VendorName           ← default root (created if "Construct Default Address Space" is checked)
     ├─ Equipment         ← created by default
     ├─ PhysicalAssets    ← created by default
     ├─ FreeMemory        ← default variable (% free memory)
     └─ Counter           ← default variable (incrementing counter)
```

Use the `setFolder` command to change which folder new nodes are added under:

```json
{"command": "setFolder", "nodeId": "ns=1;s=Equipment"}
```

After this, any `addVariable`, `addFolder`, etc. will place new nodes under Equipment.

#### Commands

All commands are sent as `msg.command`. Responses come from the server's output port.

##### Variables

**`addVariable`** — Add one or more variables to the address space

```json
{
  "command": "addVariable",
  "items": [
    {
      "nodeId": "ns=1;s=Temperature",
      "datatype": "Double",
      "value": 25.0,
      "browseName": "Temperature",
      "displayName": "Room Temperature",
      "description": "Current room temperature in Celsius"
    }
  ]
}
```

| Item Property | Required | Description |
|---------------|----------|-------------|
| `nodeId` | Yes | Full OPC UA NodeId (e.g. `ns=1;s=MyVar`) |
| `datatype` | Yes | `Double`, `Int32`, `Boolean`, `String`, `UInt32`, `Float`, `DateTime`, `ByteString`, etc. Append `Array` for arrays (e.g. `DoubleArray`) |
| `value` | No | Initial value (defaults to 0 or empty for the type) |
| `browseName` | No | Derived from nodeId if omitted |
| `displayName` | No | Defaults to browseName |
| `description` | No | Node description |

Variables are placed under the current folder (set by `setFolder` or `VendorName` by default). Output includes created node details.

**`deleteNode`** — Remove node(s) from the address space

```json
{"command": "deleteNode", "nodeId": "ns=1;s=Temperature"}
```
```json
{"command": "deleteNode", "items": [{"nodeId": "ns=1;s=Temp1"}, {"nodeId": "ns=1;s=Temp2"}]}
```

##### Folders

**`setFolder`** — Set the parent folder for subsequent add operations

```json
{"command": "setFolder", "nodeId": "ns=1;s=Equipment"}
```

**`addFolder`** — Create folder(s) under the current parent

```json
{
  "command": "addFolder",
  "items": [
    {
      "nodeId": "ns=1;s=Sensors",
      "browseName": "Sensors",
      "description": "All sensor values"
    }
  ]
}
```

##### Methods

**`addMethod`** — Add a method to a parent node

```json
{
  "command": "addMethod",
  "parentNodeId": "ns=1;s=Equipment",
  "methodName": "StartProcess",
  "inputArguments": [
    {"name": "speed", "type": "Double", "text": "Motor speed in RPM"}
  ],
  "outputArguments": [
    {"name": "success", "type": "Boolean", "text": "Whether it started"}
  ]
}
```

Methods are created with a `BadNotImplemented` default — use `bindMethod` to attach logic.

**`bindMethod`** — Bind an implementation to an existing method

```json
{
  "command": "bindMethod",
  "nodeId": "ns=1;s=StartProcess",
  "code": "(inputArguments, context, callback) => { callback(null, { statusCode: 0, outputArguments: [{ dataType: 1, value: true }] }); }"
}
```

##### Alarms

**`installDiscreteAlarm`** — Boolean (on/off) alarm on a variable

```json
{
  "command": "installDiscreteAlarm",
  "items": [{"nodeId": "ns=1;s=DoorOpen"}],
  "priority": 500,
  "alarmText": "Door is open!"
}
```

Creates a `<name>AlarmState` Boolean variable and a `DiscreteAlarm`. Set the AlarmState variable to `true` to trigger the alarm.

**`installLimitAlarm`** — Non-exclusive limit alarm (HH/H/L/LL)

```json
{
  "command": "installLimitAlarm",
  "items": [{"nodeId": "ns=1;s=Pressure"}],
  "hh": 95, "h": 80, "l": 20, "ll": 5,
  "priority": 700,
  "alarmText": "Pressure out of range"
}
```

Creates a `<name>LimitState` Double variable and a `NonExclusiveLimitAlarm`.

##### Files

**`addFile`** — Add an OPC UA File Transfer node

```json
{
  "command": "addFile",
  "nodeId": "ns=1;s=LogFile",
  "fileName": "/var/log/process.log"
}
```

##### History

**`installHistorian`** — Enable historical data collection

```json
{
  "command": "installHistorian",
  "items": [{"nodeId": "ns=1;s=Temperature"}]
}
```

Stores up to 1000 online values per variable.

##### Equipment & Assets

**`addEquipment`** — Add an Equipment object under VendorName

```json
{"command": "addEquipment", "nodeName": "ConveyorBelt"}
```

**`addPhysicalAsset`** — Add a Physical Asset object under VendorName

```json
{"command": "addPhysicalAsset", "nodeName": "Motor01"}
```

##### Extension Objects

**`addExtensionObject`** — Add a structured data variable

```json
{
  "command": "addExtensionObject",
  "items": [{"nodeId": "ns=1;s=SensorData", "typeId": "ns=1;i=5001", "browseName": "SensorData"}]
}
```

##### Namespaces

**`registerNamespace`** — Register a new namespace

```json
{"command": "registerNamespace", "namespaceUri": "http://my-company.com/devices"}
```
Output: `msg.payload = "ns=2"` (the assigned index)

**`getNamespaceIndex`** — Get the index of an existing namespace

```json
{"command": "getNamespaceIndex", "namespaceUri": "http://my-company.com/devices"}
```

**`getNamespaces`** — List all namespaces

```json
{"command": "getNamespaces"}
```
Output: `msg.payload = {"http://opcfoundation.org/UA/": 0, "urn:hostname:NodeOPCUA-Server": 1, ...}`

##### Users

**`setUsers`** — Update user credentials at runtime

```json
{
  "command": "setUsers",
  "users": [
    {"username": "admin", "password": "secret123"},
    {"username": "operator", "password": "op456", "roles": ["AuthenticatedUser"]}
  ]
}
```

Users can also be loaded from a JSON file (configured in the editor).

##### Persistence

**`saveAddressSpace`** — Export address space to XML

```json
{"command": "saveAddressSpace", "filename": "/tmp/my_addressspace.xml", "namespaceIndex": 1}
```

**`loadAddressSpace`** — Load address space from XML (triggers server restart)

```json
{"command": "loadAddressSpace", "filename": "/tmp/my_addressspace.xml"}
```

**`bindVariables`** — Bind get/set callbacks to all variables in the address space

```json
{"command": "bindVariables"}
```
Output: `msg.payload = "Bound 42 variables"`

##### Lifecycle

**`restartOPCUAServer`** — Graceful server restart

```json
{"command": "restartOPCUAServer"}
```

#### Variable Updates (No Command)

To update existing variables without a command, send `msg.items`:

```json
{
  "items": [
    {
      "nodeId": "ns=1;s=Temperature",
      "datatype": "Double",
      "value": 42.5
    },
    {
      "nodeId": "ns=1;s=Pressure",
      "datatype": "Float",
      "value": 1.013,
      "quality": "Good",
      "sourceTimestamp": "2025-03-06T12:00:00Z"
    }
  ]
}
```

| Item Property | Required | Description |
|---------------|----------|-------------|
| `nodeId` | Yes | Node to update |
| `datatype` | Yes | OPC UA data type |
| `value` | Yes | New value |
| `quality` | No | StatusCode name (e.g. `"Good"`, `"BadOutOfRange"`) or numeric code |
| `sourceTimestamp` | No | ISO string or Date object |

When `quality` or `sourceTimestamp` is provided, the update uses a precise server-side write. Otherwise it uses `setValueFromSource()` for maximum performance.

#### Server Outputs

The server sends messages on its output for:

**Session events:**
```json
{"topic": "Client-connected", "payload": "SessionName"}
{"topic": "Client-disconnected", "payload": "SessionName"}
{"topic": "Username", "payload": "admin"}
```

**Variable write notifications** (when an OPC UA client writes a variable):
```json
{
  "items": [{
    "nodeId": "ns=1;s=Temperature",
    "datatype": "Double",
    "browseName": "Temperature",
    "value": 42.5
  }]
}
```

#### Users File Format

Create a JSON file with an array of user objects:

```json
[
  {"username": "admin", "password": "secret123"},
  {"username": "operator", "password": "op456", "roles": ["AuthenticatedUser"]},
  {"username": "viewer", "password": "view789", "roles": ["Anonymous"]}
]
```

The file is searched in these locations (in order):
1. The path as-is
2. `<cwd>/<path>`
3. `<cwd>/.node-red/<path>`

#### Complete Example Flow

```
[inject: setFolder] → [server]
[inject: addVariable] → [server]
[inject: variable update] → [server]
```

1. Set up a folder:
   ```json
   {"command": "setFolder", "nodeId": "ns=1;s=Equipment"}
   ```

2. Add variables:
   ```json
   {
     "command": "addVariable",
     "items": [
       {"nodeId": "ns=1;s=Temperature", "datatype": "Double", "value": 20.0},
       {"nodeId": "ns=1;s=Pressure", "datatype": "Float", "value": 1.0}
     ]
   }
   ```

3. Update values periodically:
   ```json
   {
     "items": [
       {"nodeId": "ns=1;s=Temperature", "datatype": "Double", "value": 23.5},
       {"nodeId": "ns=1;s=Pressure", "datatype": "Float", "value": 1.023}
     ]
   }
   ```

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

# @brdk/node-red-opcua

A clean, modern Node-RED OPC UA library built on [node-opcua](https://github.com/node-opcua/node-opcua).

## Features

- **OPC UA Client** — Read, write, subscribe, browse, monitor, history, file transfer, method calls, and more (22 actions)
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
- `msg.topic` — NodeId (e.g. `ns=2;s=MyVariable`)
- `msg.datatype` — OPC UA data type
- `msg.payload` — value (coerced to correct type)

### opcua-client

Main client node with 22 actions:

| Action | Description |
|--------|-------------|
| `read` | Read a single node value |
| `write` | Write a value to a node |
| `readmultiple` | Read multiple nodes (msg.payload = array of nodeIds) |
| `writemultiple` | Write multiple values |
| `subscribe` | Create a monitored subscription |
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
    ├── opcua-client.js/.html         # Main client (22 actions)
    ├── opcua-browser.js/.html        # Address space browser
    ├── opcua-event.js/.html          # Event metadata
    ├── opcua-method.js/.html         # Method calls
    ├── opcua-discovery.js/.html      # Discovery server
    ├── opcua-server.js/.html         # OPC UA Server (21 commands)
    └── opcua-rights.js/.html         # Access rights
```

## License

Apache-2.0

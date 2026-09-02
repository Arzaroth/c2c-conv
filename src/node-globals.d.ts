// Node has had a global WebSocket since 22.4, but @types/node still only
// exports the type from node:http. Importing it there would put a runtime
// import in front of a global that is already present, so it is declared here
// instead.
declare var WebSocket: typeof import('node:http').WebSocket
type WebSocket = InstanceType<typeof import('node:http').WebSocket>

/**
 * Node face of the context-control plugin: the browser half is the only
 * implementation, registered from `./client`.
 */

export const name = 'ui-context-control'

export const apply = (): void => {
  // No Host side: the seat occupant lives in the Client face.
}

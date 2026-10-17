export interface AdapterLog {
  info(message: string): void
  error(message: string): void
}

export const silentLog: AdapterLog = {
  info: () => {},
  error: () => {},
}

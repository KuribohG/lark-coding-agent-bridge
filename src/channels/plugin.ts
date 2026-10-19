export interface ChannelConnection {
  close(): Promise<void>;
}

/** A configured channel owns its transport and presentation, and uses the shared runtime. */
export interface ChannelPlugin<C extends ChannelConnection = ChannelConnection> {
  readonly id: string;
  connect(): Promise<C>;
}

/** No SDK imports, credential formats or channel-specific startup branches. */
export class ChannelHost {
  private readonly connections = new Map<string, Promise<ChannelConnection>>();
  private closed = false;
  private closing?: Promise<void>;

  async connect<C extends ChannelConnection>(plugin: ChannelPlugin<C>): Promise<C> {
    if (this.closed) throw new Error('channel host is closed');
    if (!plugin.id.trim() || this.connections.has(plugin.id)) throw new Error(`duplicate or empty channel: ${plugin.id}`);
    const connecting = Promise.resolve().then(() => plugin.connect());
    this.connections.set(plugin.id, connecting);
    try {
      const connection = await connecting;
      if (this.closed) throw new Error('channel host is closed');
      return connection;
    }
    catch (error) { this.connections.delete(plugin.id); throw error; }
  }

  close(): Promise<void> {
    return this.closing ??= this.closeAll();
  }

  private async closeAll(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.connections.values()].map(async connection => (await connection).close()));
    this.connections.clear();
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(r => r.reason), 'channel shutdown failed');
  }
}

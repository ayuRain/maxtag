import type {
  Executor,
  ExecutorDescriptor,
  ExecutorRegistration,
  ExecutorRegistry,
} from './types.js';

function copyDescriptor(descriptor: ExecutorDescriptor): ExecutorDescriptor {
  return {
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
  };
}

export class StaticExecutorRegistry implements ExecutorRegistry {
  readonly defaultExecutorId: string;
  private readonly registrations = new Map<string, ExecutorRegistration>();

  constructor(input: {
    defaultExecutorId: string;
    registrations?: ExecutorRegistration[];
  }) {
    this.defaultExecutorId = input.defaultExecutorId.trim();
    if (!this.defaultExecutorId) throw new Error('default_executor_required');
    for (const registration of input.registrations ?? []) {
      this.register(registration);
    }
    if (!this.registrations.has(this.defaultExecutorId)) {
      throw new Error(`default_executor_not_registered:${this.defaultExecutorId}`);
    }
  }

  register(registration: ExecutorRegistration): this {
    const id = registration.descriptor.id.trim();
    if (!id || registration.executor.id !== id) {
      throw new Error(`executor_registration_id_mismatch:${id || 'missing'}`);
    }
    if (this.registrations.has(id)) {
      throw new Error(`executor_already_registered:${id}`);
    }
    this.registrations.set(id, {
      descriptor: copyDescriptor({ ...registration.descriptor, id }),
      executor: registration.executor,
    });
    return this;
  }

  get(id: string): Executor | undefined {
    return this.registrations.get(id)?.executor;
  }

  has(id: string): boolean {
    return this.registrations.has(id);
  }

  describe(id: string): ExecutorDescriptor | undefined {
    const descriptor = this.registrations.get(id)?.descriptor;
    return descriptor ? copyDescriptor(descriptor) : undefined;
  }

  list(): ExecutorDescriptor[] {
    return [...this.registrations.values()].map(({ descriptor }) =>
      copyDescriptor(descriptor),
    );
  }

  toRecord(): Record<string, Executor> {
    return Object.fromEntries(
      [...this.registrations].map(([id, registration]) => [
        id,
        registration.executor,
      ]),
    );
  }
}

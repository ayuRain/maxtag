import type { SourceThread } from '@opentag/core';
import { FileRoutineStore } from './file-routine-store.js';
import type { Routine, RoutineSchedule } from './types.js';

export type RoutineCommandKind =
  | 'list'
  | 'help'
  | 'create'
  | 'pause'
  | 'resume'
  | 'delete';

export type ParsedRoutineCommand =
  | { kind: 'list' }
  | { kind: 'help' }
  | {
      kind: 'create';
      instructions: string;
      schedule: RoutineSchedule;
    }
  | {
      kind: 'pause' | 'resume' | 'delete';
      selector: string;
    };

export interface RoutineCommandResult {
  action: RoutineCommandKind;
  summary: string;
  routine?: Routine;
  routines?: Routine[];
}

function stripAddressing(text: string): string {
  return text
    .trim()
    .replace(/^(@\S+\s*)+/u, '')
    .replace(/^\/(?:opentag|tag)(?:@[a-z0-9_]+)?(?:\s+|$)/iu, '')
    .replace(/^\//u, '')
    .trim();
}

function promptValue(value: string): string {
  return value.replace(/^\s*[:：|]\s*/u, '').trim();
}

function intervalMinutes(value: string, unit: string): number {
  const amount = Number(value);
  return /^(?:h|hr|hrs|hour|hours|小时)$/iu.test(unit)
    ? amount * 60
    : amount;
}

function parseCreate(
  text: string,
  defaultTimeZone: string,
): ParsedRoutineCommand | null {
  const interval = /^(?:(?:schedule|add)\s+)?every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b([\s\S]+)$/iu.exec(
    text,
  );
  if (interval) {
    const instructions = promptValue(interval[3]);
    if (!instructions) return null;
    return {
      kind: 'create',
      instructions,
      schedule: {
        kind: 'interval',
        everyMinutes: intervalMinutes(interval[1], interval[2]),
      },
    };
  }

  const intervalZh = /^(?:(?:安排|创建|设置)\s*)?每\s*(\d+)\s*(分钟|小时)([\s\S]+)$/u.exec(
    text,
  );
  if (intervalZh) {
    const instructions = promptValue(intervalZh[3]);
    if (!instructions) return null;
    return {
      kind: 'create',
      instructions,
      schedule: {
        kind: 'interval',
        everyMinutes: intervalMinutes(intervalZh[1], intervalZh[2]),
      },
    };
  }

  const daily = /^(?:(?:schedule|add)\s+)?(?:daily|every\s+day)\s+([0-2]\d:[0-5]\d)(?:\s+([a-z_][a-z0-9_+\-]*(?:\/[a-z0-9_+\-]+)+))?([\s\S]+)$/iu.exec(
    text,
  );
  if (daily) {
    const instructions = promptValue(daily[3]);
    if (!instructions) return null;
    return {
      kind: 'create',
      instructions,
      schedule: {
        kind: 'daily',
        time: daily[1],
        timeZone: daily[2] || defaultTimeZone,
      },
    };
  }

  const dailyZh = /^(?:(?:安排|创建|设置)\s*)?每天\s*([0-2]\d:[0-5]\d)(?:\s+([a-z_][a-z0-9_+\-]*(?:\/[a-z0-9_+\-]+)+))?([\s\S]+)$/iu.exec(
    text,
  );
  if (!dailyZh) return null;
  const instructions = promptValue(dailyZh[3]);
  if (!instructions) return null;
  return {
    kind: 'create',
    instructions,
    schedule: {
      kind: 'daily',
      time: dailyZh[1],
      timeZone: dailyZh[2] || defaultTimeZone,
    },
  };
}

function parseLifecycle(text: string): ParsedRoutineCommand | null {
  const patterns: Array<[
    RegExp,
    Extract<RoutineCommandKind, 'pause' | 'resume' | 'delete'>,
  ]> = [
    [/^(?:(?:pause|disable|stop|turn\s+off)\s+(?:routine|trigger))\s+(.+)$/iu, 'pause'],
    [/^(?:(?:resume|enable|turn\s+on)\s+(?:routine|trigger))\s+(.+)$/iu, 'resume'],
    [/^(?:delete|remove)\s+(?:routine|trigger)\s+(.+)$/iu, 'delete'],
    [/^(?:暂停|停用)\s*(?:定时任务|触发器|任务)\s+(.+)$/u, 'pause'],
    [/^(?:恢复|启用)\s*(?:定时任务|触发器|任务)\s+(.+)$/u, 'resume'],
    [/^(?:删除|移除)\s*(?:定时任务|触发器|任务)\s+(.+)$/u, 'delete'],
  ];
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(text);
    const selector = match?.[1]?.trim();
    if (selector) return { kind, selector };
  }
  return null;
}

export function parseRoutineCommand(
  input: string,
  options: { defaultTimeZone?: string } = {},
): ParsedRoutineCommand | null {
  const text = stripAddressing(input);
  const lower = text.toLowerCase();
  if (
    ['routines', 'routine', 'triggers', 'standing work', '定时任务', '触发器', '持续任务'].includes(
      lower,
    )
  ) {
    return { kind: 'list' };
  }
  if (
    ['routines help', 'routine help', 'triggers help', '定时任务帮助', '触发器帮助'].includes(
      lower,
    )
  ) {
    return { kind: 'help' };
  }
  return (
    parseLifecycle(text) ||
    parseCreate(text, options.defaultTimeZone || 'UTC')
  );
}

export function formatRoutineSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === 'daily') {
    return `Daily at ${schedule.time} (${schedule.timeZone})`;
  }
  return `Every ${schedule.everyMinutes} minute${schedule.everyMinutes === 1 ? '' : 's'}`;
}

function routineName(instructions: string): string {
  const firstLine = instructions.split('\n', 1)[0].replace(/\s+/gu, ' ').trim();
  return firstLine.length <= 64 ? firstLine : `${firstLine.slice(0, 61)}...`;
}

function routineId(routine: Routine): string {
  return routine.id.slice(0, 8);
}

function helpText(): string {
  return [
    'Standing work commands:',
    '- schedule every 30m: Check CI failures',
    '- schedule daily 09:00 Asia/Shanghai: Summarize open work',
    '- routines',
    '- pause routine <id>',
    '- resume routine <id>',
    '- delete routine <id>',
  ].join('\n');
}

function serviceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('routine_invalid_time_zone')) {
    return 'That time zone is not valid. Use an IANA zone such as Asia/Shanghai.';
  }
  if (message.includes('routine_interval_minutes_must_be_between')) {
    return 'The interval must be between 1 minute and 30 days.';
  }
  if (message.includes('routine_daily_time_must_be')) {
    return 'Daily time must use 24-hour HH:mm format.';
  }
  return `Could not update standing work: ${message}`;
}

export class RoutineCommandService {
  constructor(
    private readonly store: FileRoutineStore,
    private readonly options: { defaultTimeZone?: string } = {},
  ) {}

  parse(text: string): ParsedRoutineCommand | null {
    return parseRoutineCommand(text, {
      defaultTimeZone: this.options.defaultTimeZone || 'UTC',
    });
  }

  async execute(
    command: ParsedRoutineCommand,
    thread: SourceThread,
    actor: string,
  ): Promise<RoutineCommandResult> {
    if (command.kind === 'help') {
      return { action: command.kind, summary: helpText() };
    }
    if (command.kind === 'list') {
      const routines = await this.routinesForThread(thread);
      if (!routines.length) {
        return {
          action: command.kind,
          summary: 'No standing work is configured in this thread.',
          routines,
        };
      }
      const lines = routines.slice(0, 20).map((routine) => {
        const state = routine.enabled ? 'on' : 'paused';
        const next = routine.nextRunAt ? `, next ${routine.nextRunAt}` : '';
        return `- ${routineId(routine)} [${state}] ${formatRoutineSchedule(routine.schedule)} - ${routine.name}${next}`;
      });
      if (routines.length > lines.length) {
        lines.push(`- ...and ${routines.length - lines.length} more`);
      }
      return {
        action: command.kind,
        summary: `Standing work in this thread:\n${lines.join('\n')}`,
        routines,
      };
    }
    if (command.kind === 'create') {
      try {
        const routine = await this.store.upsertRoutine({
          workspaceId: thread.workspaceId || 'dev-workspace',
          projectId: thread.projectId,
          name: routineName(command.instructions),
          instructions: command.instructions,
          schedule: command.schedule,
          destination: {
            platform: thread.platform,
            externalId: thread.externalId,
            channelId: thread.channelId,
            threadId: thread.id,
            rootMessageId: thread.rootMessageId,
            topicId: thread.topicId,
            visibility: thread.visibility,
            title: thread.title,
          },
          actor,
        });
        return {
          action: command.kind,
          summary: [
            `Standing work created: ${routine.name}`,
            `ID: ${routineId(routine)}`,
            `Schedule: ${formatRoutineSchedule(routine.schedule)}`,
            `Next: ${routine.nextRunAt}`,
          ].join('\n'),
          routine,
        };
      } catch (error) {
        return { action: command.kind, summary: serviceError(error) };
      }
    }

    const resolved = await this.resolveRoutine(thread, command.selector);
    if ('summary' in resolved) {
      return { action: command.kind, summary: resolved.summary };
    }
    if (command.kind === 'delete') {
      const routine = await this.store.deleteRoutine(resolved.routine.id, actor);
      return {
        action: command.kind,
        summary: `Standing work deleted: ${resolved.routine.name}`,
        routine,
      };
    }
    const enabled = command.kind === 'resume';
    const routine = await this.store.setRoutineEnabled(
      resolved.routine.id,
      enabled,
      actor,
    );
    return {
      action: command.kind,
      summary: `Standing work ${enabled ? 'resumed' : 'paused'}: ${resolved.routine.name}${routine?.nextRunAt ? `\nNext: ${routine.nextRunAt}` : ''}`,
      routine,
    };
  }

  private async routinesForThread(thread: SourceThread): Promise<Routine[]> {
    const routines = await this.store.listRoutines({
      workspaceId: thread.workspaceId || 'dev-workspace',
      projectId: thread.projectId,
    });
    return routines.filter((routine) => {
      if (routine.destination.platform !== thread.platform) return false;
      if (routine.destination.externalId === thread.externalId) return true;
      return Boolean(
        !routine.destination.rootMessageId &&
          !routine.destination.topicId &&
          thread.channelId &&
          routine.destination.channelId === thread.channelId,
      );
    });
  }

  private async resolveRoutine(
    thread: SourceThread,
    selector: string,
  ): Promise<{ routine: Routine } | { summary: string }> {
    const routines = await this.routinesForThread(thread);
    const normalized = selector.trim().toLowerCase();
    const idMatches = routines.filter(
      (routine) =>
        routine.id.toLowerCase() === normalized ||
        routine.id.toLowerCase().startsWith(normalized),
    );
    if (idMatches.length === 1) return { routine: idMatches[0] };
    const nameMatches = routines.filter(
      (routine) => routine.name.toLowerCase() === normalized,
    );
    if (nameMatches.length === 1) return { routine: nameMatches[0] };
    const fuzzyMatches = routines.filter((routine) =>
      routine.name.toLowerCase().includes(normalized),
    );
    if (fuzzyMatches.length === 1) return { routine: fuzzyMatches[0] };
    if (idMatches.length + nameMatches.length + fuzzyMatches.length > 1) {
      return {
        summary: `More than one standing work item matches "${selector}". Use its ID from the routines list.`,
      };
    }
    return {
      summary: `No standing work in this thread matches "${selector}".`,
    };
  }
}

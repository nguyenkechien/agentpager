import { z } from 'zod';
import { LOG_LEVEL_NAMES } from '../../shared/api.js';
import { INVOKE, type InvokeChannel } from '../../shared/channels.js';

const text = z.string().max(4_096);
const path = text.min(1);
const nullablePath = path.nullable();

const settingsPatch = z
  .object({
    botToken: text.optional(),
    projectsRoot: path.optional(),
    idleTimeoutMinutes: z.number().int().optional(),
    logLevel: z.enum(LOG_LEVEL_NAMES).optional(),
    agent: z
      .object({
        provider: text.min(1).optional(),
        executable: nullablePath.optional(),
        defaultModel: text.min(1).nullable().optional(),
        defaultEffort: text.min(1).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const wizardInput = z
  .object({
    botToken: text,
    usernames: z.array(text).max(100),
    projectsRoot: path,
    agent: z.object({ provider: text.min(1), executable: nullablePath }).strict(),
    idleTimeoutMinutes: z.number().int(),
  })
  .strict();

const none = z.tuple([]);

/** Argument tuples per channel; anything else from the renderer is rejected before reaching a service. */
export const INVOKE_ARGS = {
  [INVOKE.configLoad]: none,
  [INVOKE.configSave]: z.tuple([settingsPatch]),
  [INVOKE.configRunWizard]: z.tuple([wizardInput, z.boolean()]),
  [INVOKE.configVerifyToken]: z.tuple([text]),
  [INVOKE.configDefaults]: none,
  [INVOKE.usersAdd]: z.tuple([text]),
  [INVOKE.usersRemove]: z.tuple([text]),
  [INVOKE.usersUnpair]: z.tuple([text]),
  [INVOKE.daemonStatus]: none,
  [INVOKE.daemonStart]: none,
  [INVOKE.daemonStop]: none,
  [INVOKE.daemonRestart]: none,
  [INVOKE.daemonSwitchToApp]: none,
  [INVOKE.autostartGet]: none,
  [INVOKE.autostartSet]: z.tuple([z.boolean()]),
  [INVOKE.loginItemGet]: none,
  [INVOKE.loginItemSet]: z.tuple([z.boolean()]),
  [INVOKE.agentProviders]: none,
  [INVOKE.agentDetect]: z.tuple([text.min(1), nullablePath]),
  [INVOKE.dialogPickFolder]: z.tuple([nullablePath]),
  [INVOKE.dialogPickExecutable]: z.tuple([nullablePath]),
  [INVOKE.shellOpenLogFolder]: none,
  [INVOKE.shellOpenConfigFile]: none,
  [INVOKE.appInfo]: none,
  [INVOKE.appUninstall]: none,
  [INVOKE.updateGet]: none,
  [INVOKE.updateCheck]: none,
  [INVOKE.updateInstall]: z.tuple([z.enum(['ask', 'when_idle', 'now'])]),
  [INVOKE.updateCancelWaiting]: none,
  [INVOKE.updateOpenDownload]: none,
  [INVOKE.logsSubscribe]: z.tuple([text.min(1).max(100), z.enum(['worker', 'supervisor'])]),
  [INVOKE.logsUnsubscribe]: z.tuple([text.min(1).max(100)]),
} satisfies Record<InvokeChannel, z.ZodType<unknown[]>>;

export type InvokeArgs<C extends InvokeChannel> = z.infer<(typeof INVOKE_ARGS)[C]>;

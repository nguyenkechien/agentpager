import type { Command } from '../types.js';
import { stopDaemon } from './daemonControl.js';

export const stopCommand: Command = (_args, io, deps) => stopDaemon(io, deps);

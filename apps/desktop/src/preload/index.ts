import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('agentpager', {});

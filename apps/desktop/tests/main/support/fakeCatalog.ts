import type { ProviderCatalogEntry } from '@chiennguyen/agentpager/providers';

export const fakeEntry: ProviderCatalogEntry = {
  id: 'fake',
  displayName: 'Fake Agent',
  capabilities: {
    interrupt: 'native',
    approvals: true,
    askUser: true,
    sessionListing: true,
    commandGuard: true,
    fileSendTool: true,
    imageInput: 'native',
    usage: 'plan-limits',
  },
  models: [
    { id: 'smart', label: 'Smart' },
    { id: 'fast', label: 'Fast' },
  ],
  efforts: ['low', 'high'],
  detect: ({ executable }) =>
    Promise.resolve(
      executable === null
        ? { executable: 'C:\\tools\\agent.exe', version: '1.0.0 (Fake)', problems: [] }
        : { executable, version: null, problems: [`Could not run ${executable}`] },
    ),
};

export const fakeCatalog: readonly ProviderCatalogEntry[] = [fakeEntry];

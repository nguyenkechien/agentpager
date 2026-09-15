import { describe, expect, it } from 'vitest';
import { AgentService } from '../../../src/main/services/agentService.js';
import { toApiError } from '../../../src/main/services/results.js';
import { fakeCatalog } from '../support/fakeCatalog.js';

describe('AgentService', () => {
  const service = new AgentService(fakeCatalog);

  it('lists providers with their models and efforts', () => {
    expect(service.providers()).toEqual([
      {
        id: 'fake',
        displayName: 'Fake Agent',
        models: [
          { id: 'smart', label: 'Smart' },
          { id: 'fast', label: 'Fast' },
        ],
        efforts: ['low', 'high'],
      },
    ]);
  });

  it('detects the agent CLI, with or without a chosen file', async () => {
    await expect(service.detect('fake', null)).resolves.toEqual({ executable: 'C:\\tools\\agent.exe', version: '1.0.0 (Fake)', problems: [] });
    await expect(service.detect('fake', 'D:\\bin\\agent.exe')).resolves.toEqual({
      executable: 'D:\\bin\\agent.exe',
      version: null,
      problems: ['Could not run D:\\bin\\agent.exe'],
    });
  });

  it('rejects an unknown provider', async () => {
    const error = await service.detect('other', null).then(
      () => null,
      (reason: unknown) => toApiError(reason),
    );
    expect(error).toEqual({ code: 'invalid_input', message: 'Unknown agent "other".' });
  });
});

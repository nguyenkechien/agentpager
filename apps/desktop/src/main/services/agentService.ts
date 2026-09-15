import type { ProviderCatalogEntry } from '@chiennguyen/agentpager/providers';
import type { AgentDetectionView, ProviderView } from '../../shared/api.js';
import { ApiFailure } from './results.js';

export class AgentService {
  constructor(private readonly catalog: readonly ProviderCatalogEntry[]) {}

  providers(): ProviderView[] {
    return this.catalog.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      models: entry.models.map((model) => ({ id: model.id, label: model.label })),
      efforts: [...entry.efforts],
    }));
  }

  async detect(provider: string, executable: string | null): Promise<AgentDetectionView> {
    const entry = this.catalog.find((candidate) => candidate.id === provider);
    if (!entry) throw new ApiFailure({ code: 'invalid_input', message: `Unknown agent "${provider}".` });
    const detection = await entry.detect({ executable });
    return { executable: detection.executable, version: detection.version, problems: [...detection.problems] };
  }
}

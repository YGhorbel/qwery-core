import { Result } from '../../common';
import type {
  IDatasourceMetadataRepository,
  IDatasourceRepository,
} from '../../repositories';
import type {
  GetDatasourceSchemaError,
  GetDatasourceSchemaInput,
  GetDatasourceSchemaOutput,
  GetDatasourceSchemaUseCase,
  TransformMetadataToCompactSchemaUseCase,
} from '../../usecases';

export class GetDatasourceSchemaService implements GetDatasourceSchemaUseCase {
  constructor(
    private readonly datasourceRepository: IDatasourceRepository,
    private readonly datasourceMetadataRepository: IDatasourceMetadataRepository,
    private readonly compactSchemaTransformer: TransformMetadataToCompactSchemaUseCase,
  ) {}

  public async execute(
    input: GetDatasourceSchemaInput,
  ): Promise<Result<GetDatasourceSchemaOutput, GetDatasourceSchemaError>> {
    const mode = input.mode ?? 'compact';
    const datasource = await this.datasourceRepository.findById(
      input.datasourceId,
    );

    if (!datasource) {
      return Result.fail({
        code: 'DATASOURCE_NOT_FOUND',
        message: `Datasource with id '${input.datasourceId}' not found`,
        datasourceId: input.datasourceId,
      });
    }

    let metadata;
    try {
      metadata =
        await this.datasourceMetadataRepository.getMetadata(datasource);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to load datasource metadata';
      return Result.fail({
        code: 'SCHEMA_METADATA_UNAVAILABLE',
        message,
        datasourceId: input.datasourceId,
      });
    }

    if (mode === 'compact') {
      const schema = await this.compactSchemaTransformer.execute({ metadata });
      return Result.ok({
        schema,
        mode,
      });
    }

    return Result.ok({
      schema: metadata,
      mode,
    });
  }
}

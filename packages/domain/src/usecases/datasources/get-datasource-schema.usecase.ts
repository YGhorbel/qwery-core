import { UseCase } from '../usecase';
import type { Result } from '../../common';
import type {
  CompactDatasourceSchema,
  DatasourceMetadata,
} from '../../entities';

export type GetSchemaMode = 'compact' | 'legacy';

export interface GetDatasourceSchemaInput {
  datasourceId: string;
  mode?: GetSchemaMode;
}

export interface GetDatasourceSchemaOutput {
  schema: CompactDatasourceSchema | DatasourceMetadata;
  mode: GetSchemaMode;
}

export type GetDatasourceSchemaError =
  | {
      code: 'DATASOURCE_NOT_FOUND';
      message: string;
      datasourceId: string;
    }
  | {
      code: 'SCHEMA_METADATA_UNAVAILABLE';
      message: string;
      datasourceId: string;
    };

export type GetDatasourceSchemaUseCase = UseCase<
  GetDatasourceSchemaInput,
  Result<GetDatasourceSchemaOutput, GetDatasourceSchemaError>
>;

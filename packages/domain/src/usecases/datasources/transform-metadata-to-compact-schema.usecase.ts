import { UseCase } from '../usecase';
import type {
  CompactDatasourceSchema,
  DatasourceMetadata,
} from '../../entities';

export interface TransformMetadataToCompactSchemaInput {
  metadata: DatasourceMetadata;
  includePrimaryKeys?: boolean;
  includeForeignKeys?: boolean;
}

export type TransformMetadataToCompactSchemaUseCase = UseCase<
  TransformMetadataToCompactSchemaInput,
  CompactDatasourceSchema
>;

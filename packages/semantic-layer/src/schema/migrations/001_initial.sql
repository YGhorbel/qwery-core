-- Semantic Layer Initial Schema Migration
-- This migration creates the core tables for semantic ontology, mappings, and cache

-- Semantic Ontology Table
-- Stores the structured ontology definitions loaded from YAML files
CREATE TABLE IF NOT EXISTS semantic_ontology (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version VARCHAR(20) NOT NULL,
  concept_id VARCHAR(255) NOT NULL,
  ontology_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(version, concept_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_ontology_version ON semantic_ontology(version);
CREATE INDEX IF NOT EXISTS idx_semantic_ontology_concept ON semantic_ontology(concept_id);
CREATE INDEX IF NOT EXISTS idx_semantic_ontology_data ON semantic_ontology USING GIN (ontology_data);

-- Semantic Mappings Table
-- Maps datasource tables to ontology concepts
CREATE TABLE IF NOT EXISTS semantic_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  datasource_id UUID NOT NULL,
  ontology_version VARCHAR(20) NOT NULL,
  table_schema VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL,
  concept_id VARCHAR(255) NOT NULL,
  confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0.00 AND confidence <= 1.00),
  synonyms TEXT[] DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (ontology_version, concept_id) REFERENCES semantic_ontology(version, concept_id) ON DELETE CASCADE,
  UNIQUE(datasource_id, table_schema, table_name, ontology_version)
);

CREATE INDEX IF NOT EXISTS idx_semantic_mappings_datasource ON semantic_mappings(datasource_id);
CREATE INDEX IF NOT EXISTS idx_semantic_mappings_concept ON semantic_mappings(concept_id);
CREATE INDEX IF NOT EXISTS idx_semantic_mappings_synonyms ON semantic_mappings USING GIN (synonyms);

-- Semantic Column Mappings Table
-- Maps datasource columns to ontology properties
CREATE TABLE IF NOT EXISTS semantic_column_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id UUID NOT NULL,
  column_name VARCHAR(255) NOT NULL,
  property_id VARCHAR(255) NOT NULL,
  confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0.00 AND confidence <= 1.00),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  FOREIGN KEY (mapping_id) REFERENCES semantic_mappings(id) ON DELETE CASCADE,
  UNIQUE(mapping_id, column_name)
);

CREATE INDEX IF NOT EXISTS idx_semantic_column_mappings_mapping ON semantic_column_mappings(mapping_id);
CREATE INDEX IF NOT EXISTS idx_semantic_column_mappings_property ON semantic_column_mappings(property_id);

-- Semantic Cache Table
-- Caches compiled semantic queries and results
CREATE TABLE IF NOT EXISTS semantic_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(255) UNIQUE NOT NULL,
  datasource_id UUID NOT NULL,
  semantic_plan JSONB NOT NULL,
  compiled_sql TEXT NOT NULL,
  result_summary JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_key ON semantic_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires ON semantic_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_datasource ON semantic_cache(datasource_id);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_plan ON semantic_cache USING GIN (semantic_plan);

-- Semantic Cache Config Table
-- Configuration for cache TTL per datasource
CREATE TABLE IF NOT EXISTS semantic_cache_config (
  datasource_id UUID PRIMARY KEY,
  ttl_hours INTEGER NOT NULL DEFAULT 24,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

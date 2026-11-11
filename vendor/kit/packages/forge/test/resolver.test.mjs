// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/openapi-resolver.test.ts (origin commit: ../ORIGIN.json).
// Copyright Cloudflare, Inc. Modifications copyright 2026 Iran Open Finance: TypeScript to JavaScript; neutral
// identifiers instead of Cloudflare's (zones → spaces, cf-trace → x-trace); assertions unchanged. The native
// behaviours (every method, derived operationIds, bodies, parameters, 2xx) are tested in native.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Forge } from '../src/forge.js';
import { populateOperationMap, resolveOperation } from '../src/openapi-resolver.js';

test('parameter metadata separates resolved type from schema identity', () => {
  populateOperationMap({
    paths: {
      '/spaces/{space_id}': {
        get: {
          operationId: 'get-space',
          parameters: [
            {
              name: 'space_id',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/SpaceIdentifierAlias' },
            },
            {
              name: 'numeric_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'statuses',
              in: 'query',
              schema: { type: 'array', items: { type: 'string', enum: ['active', 'pending'] } },
            },
            {
              name: 'alias',
              in: 'path',
              required: true,
              schema: {
                oneOf: [{ $ref: '#/components/schemas/SpaceIdentifier' }, { type: 'string' }],
              },
            },
            {
              name: 'exampleOnly',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/ExampleOnly' },
            },
            {
              name: 'status',
              in: 'query',
              schema: { $ref: '#/components/schemas/Status' },
            },
            {
              name: 'missing',
              in: 'query',
              schema: { $ref: '#/components/schemas/Missing' },
            },
            {
              name: 'cycle',
              in: 'query',
              schema: { $ref: '#/components/schemas/CycleA' },
            },
          ],
        },
      },
    },
    components: {
      schemas: {
        SpaceIdentifier: {
          type: 'string',
          description: 'Space identifier.',
        },
        SpaceIdentifierAlias: {
          allOf: [{ $ref: '#/components/schemas/SpaceIdentifier' }, { readOnly: true, type: 'string' }],
        },
        ExampleOnly: { example: 'identifier' },
        Status: {
          type: 'string',
          enum: ['active', 'pending'],
        },
        CycleA: { $ref: '#/components/schemas/CycleB' },
        CycleB: { $ref: '#/components/schemas/CycleA' },
      },
    },
  });

  const operation = resolveOperation('get-space');
  assert.ok(operation);
  assert.deepEqual(operation.pathParams[0], {
    name: 'space_id',
    required: true,
    type: 'string',
    schemaRef: 'SpaceIdentifierAlias',
    description: 'Space identifier.',
  });
  assert.deepEqual(operation.pathParams.slice(1), [
    { name: 'numeric_id', required: true, type: 'string' },
    { name: 'alias', required: true, type: 'string', composed: true, description: 'Space identifier.' },
    { name: 'exampleOnly', required: true, type: 'string', schemaRef: 'ExampleOnly' },
  ]);
  assert.deepEqual(operation.queryParams, [
    {
      name: 'tags',
      required: false,
      type: 'array',
      itemType: 'string',
    },
    {
      name: 'statuses',
      required: false,
      type: 'array',
      itemType: 'string',
      itemEnumValues: ['active', 'pending'],
    },
    {
      name: 'status',
      required: false,
      type: 'string',
      schemaRef: 'Status',
      enumValues: ['active', 'pending'],
    },
    {
      name: 'missing',
      required: false,
      type: 'unknown',
      schemaRef: 'Missing',
    },
    {
      name: 'cycle',
      required: false,
      type: 'unknown',
      schemaRef: 'CycleA',
    },
  ]);
});

test('path-item parameters are inherited and operation parameters override them', () => {
  populateOperationMap({
    paths: {
      '/spaces/{space_id}/items': {
        parameters: [
          {
            name: 'space_id',
            in: 'path',
            required: true,
            schema: { $ref: '#/components/schemas/SpaceIdentifier' },
          },
          {
            name: 'page',
            in: 'query',
            schema: { type: 'number' },
          },
        ],
        get: {
          operationId: 'list-items',
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string' },
            },
          ],
        },
      },
    },
    components: {
      schemas: {
        SpaceIdentifier: { type: 'string' },
      },
    },
  });

  const operation = resolveOperation('list-items');
  assert.ok(operation);
  assert.deepEqual(operation.pathParams, [
    {
      name: 'space_id',
      required: true,
      type: 'string',
      schemaRef: 'SpaceIdentifier',
    },
  ]);
  assert.deepEqual(operation.queryParams, [
    {
      name: 'page',
      required: true,
      type: 'string',
    },
    {
      name: 'status',
      required: false,
      type: 'string',
    },
  ]);
});

test('object array body params are exposed as JSON-valued array parameters', () => {
  populateOperationMap({
    paths: {
      '/deployments': {
        post: {
          operationId: 'create-deployment',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    versions: {
                      type: 'array',
                      description: 'Deployment versions as JSON.',
                      'x-sensitive': true,
                      items: {
                        type: 'object',
                        properties: {
                          version_id: { type: 'string' },
                          percentage: { type: 'number' },
                          metadata: {
                            type: 'object',
                            properties: { message: { type: 'string' } },
                          },
                        },
                      },
                    },
                    tags: { type: 'array', items: { type: 'string' } },
                    union_versions: {
                      type: 'array',
                      items: {
                        oneOf: [
                          { type: 'object', properties: { version_id: { type: 'string' } } },
                          { type: 'object', properties: { percentage: { type: 'number' } } },
                        ],
                      },
                    },
                    composed_versions: {
                      type: 'array',
                      items: {
                        allOf: [
                          { type: 'object', properties: { version_id: { type: 'string' } } },
                          { type: 'object', properties: { percentage: { type: 'number' } } },
                        ],
                      },
                    },
                    version_matrix: {
                      type: 'array',
                      items: {
                        type: 'array',
                        items: { type: 'object', properties: { version_id: { type: 'string' } } },
                      },
                    },
                  },
                  required: ['versions'],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-deployment');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: true,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions as JSON.',
      sensitive: true,
      apiFieldPath: ['versions'],
    },
    {
      name: 'tags',
      required: false,
      type: 'array',
      apiFieldPath: ['tags'],
    },
    {
      name: 'union-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['union_versions'],
    },
    {
      name: 'composed-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['composed_versions'],
    },
  ]);
});

test('object array body params resolve refs only for arrays directly under the body root', () => {
  populateOperationMap({
    paths: {
      '/rollouts': {
        post: {
          operationId: 'create-rollout',
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateRollout' },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateRollout: {
          type: 'object',
          properties: {
            versions: { $ref: '#/components/schemas/Versions' },
            optional_versions: { $ref: '#/components/schemas/Versions' },
            rollout: { $ref: '#/components/schemas/Rollout' },
            version_matrix: {
              type: 'array',
              items: { $ref: '#/components/schemas/Versions' },
            },
          },
          required: ['versions', 'rollout'],
        },
        Rollout: {
          type: 'object',
          properties: {
            nested_versions: { $ref: '#/components/schemas/Versions' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['nested_versions'],
        },
        Versions: {
          type: 'array',
          description: 'Deployment versions.',
          items: { $ref: '#/components/schemas/Version' },
        },
        Version: {
          type: 'object',
          properties: {
            version_id: { type: 'string' },
            percentage: { type: 'number' },
          },
        },
      },
    },
  });

  const operation = resolveOperation('create-rollout');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: true,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions.',
      apiFieldPath: ['versions'],
    },
    {
      name: 'optional-versions',
      required: false,
      type: 'array',
      itemType: 'object',
      description: 'Deployment versions.',
      apiFieldPath: ['optional_versions'],
    },
    {
      name: 'rollout-labels',
      required: false,
      type: 'array',
      apiFieldPath: ['rollout', 'labels'],
    },
  ]);
});

test('object array body params are exposed from root oneOf variants', () => {
  const versions = {
    type: 'array',
    items: {
      type: 'object',
      properties: { version_id: { type: 'string' } },
    },
  };
  populateOperationMap({
    paths: {
      '/variant-deployments': {
        post: {
          operationId: 'create-variant-deployment',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { versions },
                      required: ['versions'],
                    },
                    {
                      type: 'object',
                      properties: { versions },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-variant-deployment');
  assert.ok(operation);
  assert.deepEqual(operation.bodyParams, [
    {
      name: 'versions',
      required: false,
      type: 'array',
      itemType: 'object',
      apiFieldPath: ['versions'],
    },
  ]);
});

test('operation descriptions fall back to OpenAPI summaries', () => {
  const forge = new Forge({
    openapi: '3.0.3',
    info: { title: 'test', version: '1' },
    paths: {
      '/summary-only': {
        get: {
          operationId: 'summary-only',
          summary: 'Summary-only operation',
          responses: {},
        },
      },
    },
  });

  assert.equal(forge.getOperationDescription('summary-only'), 'Summary-only operation');
  assert.equal(forge.getDescription('summary-only'), 'Summary-only operation');
});

test('oneOf merges enum values from referenced properties in every variant', () => {
  populateOperationMap({
    paths: {
      '/pipelines': {
        post: {
          operationId: 'create-pipeline',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    format: {
                      oneOf: [
                        { $ref: '#/components/schemas/JsonFormat' },
                        { $ref: '#/components/schemas/ParquetFormat' },
                      ],
                      discriminator: { propertyName: 'type' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        JsonFormat: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['json'] },
            compression: { $ref: '#/components/schemas/JsonCompression' },
          },
          required: ['type'],
        },
        ParquetFormat: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['parquet'] },
            compression: { $ref: '#/components/schemas/ParquetCompression' },
          },
          required: ['type'],
        },
        JsonCompression: {
          type: 'string',
          enum: ['uncompressed', 'gzip'],
          default: 'uncompressed',
        },
        ParquetCompression: {
          type: 'string',
          enum: ['uncompressed', 'snappy', 'gzip', 'zstd', 'lz4'],
        },
      },
    },
  });

  const operation = resolveOperation('create-pipeline');
  assert.ok(operation);
  const compression = operation.bodyParams.find((param) => param.name === 'format-compression');
  assert.deepEqual(compression, {
    name: 'format-compression',
    required: false,
    type: 'string',
    apiFieldPath: ['format', 'compression'],
    enumValues: ['uncompressed', 'gzip', 'snappy', 'zstd', 'lz4'],
    default: 'uncompressed',
  });
});

test('x-fern-parameter-name sets sdkName on path, query, header, and referenced parameters', () => {
  populateOperationMap({
    paths: {
      '/namespaces/{name}/instances/{id}': {
        parameters: [{ $ref: '#/components/parameters/Namespace' }],
        get: {
          operationId: 'get-instance',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              'x-fern-parameter-name': 'instance-id',
            },
            {
              name: 'date_start',
              in: 'query',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'start',
            },
            {
              name: 'x-trace',
              in: 'header',
              schema: { type: 'string' },
              'x-fern-parameter-name': 'trace',
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'number' },
            },
          ],
        },
      },
    },
    components: {
      parameters: {
        Namespace: {
          name: 'name',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          'x-fern-parameter-name': 'namespace',
        },
      },
      schemas: {},
    },
  });

  const operation = resolveOperation('get-instance');
  assert.ok(operation);
  assert.deepEqual(
    operation.pathParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [
      { name: 'name', sdkName: 'namespace' },
      { name: 'id', sdkName: 'instance-id' },
    ],
  );
  assert.deepEqual(
    operation.queryParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [
      { name: 'date_start', sdkName: 'start' },
      { name: 'page', sdkName: undefined },
    ],
  );
  assert.deepEqual(
    operation.headerParams.map(({ name, sdkName }) => ({ name, sdkName })),
    [{ name: 'x-trace', sdkName: 'trace' }],
  );
});

test('x-fern-property-name renames body flag segments at every depth', () => {
  populateOperationMap({
    paths: {
      '/configs': {
        post: {
          operationId: 'create-config',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    config_src: {
                      $ref: '#/components/schemas/ConfigSource',
                      'x-fern-property-name': 'config-source',
                    },
                    version: { type: 'number', 'x-fern-property-name': 'config-version' },
                    mtls: { $ref: '#/components/schemas/Mtls' },
                    instance_retention: {
                      type: 'object',
                      properties: {
                        success_retention: { type: 'string', 'x-fern-property-name': 'success' },
                        error_retention: { type: 'string', 'x-fern-property-name': 'error' },
                      },
                    },
                    integration: {
                      type: 'object',
                      properties: {
                        integration: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ConfigSource: { type: 'string', enum: ['local', 'remote'] },
        Mtls: {
          type: 'object',
          properties: {
            ca_certificate_id: { $ref: '#/components/schemas/CaCertificateId' },
            mtls_certificate_id: { type: 'string', 'x-fern-property-name': 'certificate-id' },
          },
        },
        CaCertificateId: { type: 'string', 'x-fern-property-name': 'ignored' },
      },
    },
  });

  const operation = resolveOperation('create-config');
  assert.ok(operation);
  assert.deepEqual(
    operation.bodyParams.map(({ name, apiFieldPath }) => ({ name, apiFieldPath })),
    [
      { name: 'config-source', apiFieldPath: ['config_src'] },
      { name: 'config-version', apiFieldPath: ['version'] },
      { name: 'mtls-ca-certificate-id', apiFieldPath: ['mtls', 'ca_certificate_id'] },
      { name: 'mtls-certificate-id', apiFieldPath: ['mtls', 'mtls_certificate_id'] },
      { name: 'instance-retention-success', apiFieldPath: ['instance_retention', 'success_retention'] },
      { name: 'instance-retention-error', apiFieldPath: ['instance_retention', 'error_retention'] },
      { name: 'integration-integration', apiFieldPath: ['integration', 'integration'] },
    ],
  );
});

test('x-fern-property-name survives oneOf variant merges and renames conflicts', () => {
  populateOperationMap({
    paths: {
      '/sources': {
        post: {
          operationId: 'create-source',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['settings', 'bucket'],
                      properties: {
                        settings: {
                          type: 'object',
                          'x-fern-property-name': 'options',
                          properties: { max_items: { type: 'number' } },
                        },
                        bucket: { type: 'string', 'x-fern-property-name': 'bucket-name' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['settings', 'url'],
                      properties: {
                        settings: {
                          type: 'object',
                          properties: { depth: { type: 'number' } },
                        },
                        url: { type: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  });

  const operation = resolveOperation('create-source');
  assert.ok(operation);
  assert.deepEqual(
    operation.bodyParams.map(({ name, apiFieldPath, conflicts }) => ({ name, apiFieldPath, conflicts })),
    [
      { name: 'options-max-items', apiFieldPath: ['settings', 'max_items'], conflicts: ['options-depth', 'url'] },
      { name: 'options-depth', apiFieldPath: ['settings', 'depth'], conflicts: ['options-max-items', 'bucket-name'] },
      { name: 'bucket-name', apiFieldPath: ['bucket'], conflicts: ['options-depth', 'url'] },
      { name: 'url', apiFieldPath: ['url'], conflicts: ['options-max-items', 'bucket-name'] },
    ],
  );
});

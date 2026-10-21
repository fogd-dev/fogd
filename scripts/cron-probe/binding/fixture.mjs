// A second real S3 server has the same bucket/prefix but a different origin.
export function configureBindingFixture({ config, images, native, bucket }) {
  const endpoint = 'http://minio-other:9000';
  config.services['minio-other'] = { ...config.services.minio, volumes: ['bucket-other:/data'] };
  config.services['init-other'] = { image: images.observer.id,
    environment: { ...bucket, S3_ENDPOINT: endpoint },
    command: ['node', 'packages/runtime/src/init-bucket.mjs'], depends_on: ['minio-other'] };
  const target = native('other-target');
  target.environment = { ...target.environment, CELLD_BUCKET: 's3://identity-probe/slots/one', S3_ENDPOINT: endpoint, AWS_ENDPOINT_URL: endpoint };
  target.depends_on['init-other'] = { condition: 'service_completed_successfully' };
  config.services['other-target'] = target;
  config.volumes['bucket-other'] = {}; config.volumes['node-other-target'] = {};
}

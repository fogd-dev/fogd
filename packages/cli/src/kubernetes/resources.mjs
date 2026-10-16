// Ordinary Kubernetes resources: no custom scheduler or cluster-side operator.
export function resource(kind, name, namespace, spec, apiVersion = 'v1') {
  return { apiVersion, kind, metadata: { name, namespace, labels: { 'app.kubernetes.io/part-of': 'fogd' } }, ...spec };
}
export const labels = name => ({ 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'fogd' });
export const values = env => Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
export const secretEnv = (name, keys) => keys.map(key => ({ name: key, valueFrom: { secretKeyRef: { name, key } } }));
export function service(name, namespace, ports, headless = false) {
  return resource('Service', name, namespace, { spec: { ...(headless ? { clusterIP: 'None', publishNotReadyAddresses: true } : {}), selector: labels(name), ports: ports.map(port => ({ name: `tcp-${port}`, port, targetPort: port })) } });
}
export function claim(name, storageClass, size) {
  return { metadata: { name }, spec: { accessModes: ['ReadWriteOnce'], ...(storageClass ? { storageClassName: storageClass } : {}), resources: { requests: { storage: size } } } };
}
export function stateful(name, namespace, pod, claims, replicas = 1) {
  return resource('StatefulSet', name, namespace, { spec: {
    serviceName: name, replicas, podManagementPolicy: 'Parallel',
    updateStrategy: { type: 'OnDelete' },
    persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
    selector: { matchLabels: labels(name) },
    template: { metadata: { labels: labels(name) }, spec: { automountServiceAccountToken: false, terminationGracePeriodSeconds: 60, ...pod } },
    volumeClaimTemplates: claims,
  } }, 'apps/v1');
}
export function container(name, image, { env = [], command, args, mounts = [], port, memory = '512Mi', cpu = '1', pullPolicy = 'IfNotPresent' } = {}) {
  return { name, image, imagePullPolicy: pullPolicy, ...(command ? { command } : {}), ...(args ? { args } : {}), env,
    volumeMounts: mounts,
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu, memory } },
    ...(port ? { ports: [{ containerPort: port }], readinessProbe: { tcpSocket: { port }, periodSeconds: 3 }, startupProbe: { tcpSocket: { port }, periodSeconds: 3, failureThreshold: 60 } } : {}),
  };
}

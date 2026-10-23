// A gateway response is not proof that an application handler ran or that its data is healthy.
function responseSample(sample) {
  const status = Number.isInteger(sample?.httpStatus) && sample.httpStatus >= 200 && sample.httpStatus <= 599 ? sample.httpStatus : null;
  const headersMs = Number.isSafeInteger(sample?.headersMs) && sample.headersMs >= 0 ? sample.headersMs : null;
  const reason = sample?.reason === 'timeout' ? 'request-timeout' : sample?.reason || sample?.unavailable ? 'request-unconfirmed' : null;
  return { status, headersMs, reason };
}
export function applicationCheckReport(selection, context, sample) {
  const { status, headersMs, reason: sampleReason } = responseSample(sample), reason = context.reason || sampleReason;
  const observed = !reason && status !== null && headersMs !== null;
  return { schema: 1, app: selection.app, installation: context.installation, observedAt: context.observedAt,
    source: 'selected-gateway-network', recorded: selection.recorded,
    ingressResponse: { state: observed ? 'observed' : context.sent ? 'uncertain' : 'not-requested', httpStatus: observed ? status : null, headersMs: observed ? headersMs : null,
      reason: observed ? null : reason || 'request-unconfirmed' },
    controllerRecord: context.boundary, gatewayProcess: context.gateway, applicationExecution: 'not-proven',
    applicationHealth: 'not-observed', responseContents: 'withheld' };
}

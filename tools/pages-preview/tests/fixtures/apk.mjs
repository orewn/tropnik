import {createHash} from 'node:crypto';

export const payload = Buffer.from('A bounded binary fixture, never an actual installable APK.');
export const arm64Manifest = {
  version: '0.4.2-preview', versionCode: 6, architecture: 'arm64-v8a', minSdk: 26,
  bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex'),
  signature: 'development / debug', signingCertificateSha256: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40), workflowRunId: 1,
  compatibleWithPreviousPreview: false, physicalDeviceVerified: false,
  deviceExecutionVerified: false, releasePayloadDeviceVerified: false,
};
export const universalManifest = {
  ...arm64Manifest, architecture: 'universal', abis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
  testedArtifact: 'tropnik-preview.apk', testedArchitecture: 'x86_64',
  testedUniversalSha256: arm64Manifest.sha256, deviceTestCount: 7,
  deviceExecutionVerified: true, releasePayloadDeviceVerified: true,
  universalReleasePayloadDeviceVerified: true, installedArtifactBytesVerified: true,
  physicalDeviceVerified: false, arm64DeviceExecutionVerified: false,
};

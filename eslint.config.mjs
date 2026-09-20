import { nodeConfig, modernJavaScript, structuralSpacing } from "@cloudreve/quality/eslint";

export default [
  { ignores: [".local/**", ".artifact-cache/**"] },
  ...nodeConfig,
  modernJavaScript,
  structuralSpacing,
];

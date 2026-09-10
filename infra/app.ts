import * as cdk from "aws-cdk-lib";
import { ApRagAgentStack } from "./lib/stack.js";

const app = new cdk.App();
new ApRagAgentStack(app, "ApRagAgentStack", {
  env: {
    region: process.env.AWS_REGION ?? "us-east-1",
  },
});

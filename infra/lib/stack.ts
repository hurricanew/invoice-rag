import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaCore from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ApRagAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.NodejsFunction(this, "ApRagAgentHandler", {
      entry: path.join(__dirname, "..", "lambda", "handler.ts"),
      handler: "handler",
      runtime: lambdaCore.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        // Ephemeral: /tmp persists only across warm invocations of the
        // same container, not across cold starts or concurrent
        // invocations. Documented Stage B limitation for this time-boxed
        // deployment — DynamoDB is the intended real backing store (see
        // architecture.md), not yet wired in given the time budget.
        RUN_DATA_DIR: "/tmp/data",
        BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID ?? "amazon.nova-pro-v1:0",
        BEDROCK_GUARDRAIL_ID: process.env.BEDROCK_GUARDRAIL_ID ?? "",
        BEDROCK_GUARDRAIL_VERSION: process.env.BEDROCK_GUARDRAIL_VERSION ?? "",
        TOKEN_BUDGET_CEILING: process.env.TOKEN_BUDGET_CEILING ?? "100000",
      },
      bundling: {
        externalModules: [],
        commandHooks: {
          beforeBundling: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/finance_rag_corpus ${outputDir}/finance_rag_corpus`,
            `cp -r ${inputDir}/fixtures ${outputDir}/fixtures`,
          ],
          beforeInstall: () => [],
        },
      },
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ApplyGuardrail"],
        resources: ["*"],
      }),
    );

    // AuthType.NONE = publicly invocable by anyone with the URL, no
    // authentication at all. Deliberate time-boxed tradeoff for a short
    // demo window, NOT a production posture — anyone with this URL can
    // trigger real Bedrock calls billed to this account for as long as
    // the stack exists. Destroy the stack promptly after the demo
    // (`cdk destroy`), don't leave it running. Production would use
    // FunctionUrlAuthType.AWS_IAM (SigV4-signed requests only) or put
    // this behind API Gateway with a proper authorizer.
    const fnUrl = fn.addFunctionUrl({
      authType: lambdaCore.FunctionUrlAuthType.NONE,
    });

    new cdk.CfnOutput(this, "FunctionUrl", { value: fnUrl.url });
  }
}

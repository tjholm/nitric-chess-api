// alias the nitric gateway
import * as aws from '@pulumi/aws';
import { LocalWorkspace } from "@pulumi/pulumi/automation";
import * as fs from 'fs';
import YAML from 'yaml';

const run = async () => {
    // read the nitric.yaml file
    const projectString = fs.readFileSync('nitric.yaml');    
    const project = YAML.parse(projectString.toString());

    // Get this existing nitric stack
    const stack = await LocalWorkspace.selectStack({
        projectName: project['name'],
        stackName: `${project['name']}-aws`,
        // we're just reading the resources,
        // so no need to run updates
        program: null,
    });

    // get the current deployment state
    const currentDeployment = await stack.exportStack();
    const currentInfo = await stack.info();
    // get the arns of any apis and sort them by their nitric names
    const nitricApis: string[] = currentDeployment.deployment.resources
        .filter(({type}) => type === "aws:apigatewayv2/api:Api")
        .map(({outputs}) => outputs.id)

    console.log(currentInfo);
    // console.log(nitricApis);

    // get the current nitric stack
    const dnsStack = await LocalWorkspace.createOrSelectStack({
        projectName: `${project['name']}-dns`,
        stackName: `${project['name']}-dns-aws`,
        program: async () => {
            // Get the existing nitric APIs
            const apis = await Promise.all(nitricApis.map(async (apiId) => {
                return await aws.apigatewayv2.getApi({ apiId });
            }));

            apis.map(api => {
                const nitricName = api.tags['x-nitric-name'];
                // Apply as sub domain of nitric e.g. api.example.com
                const domain = `${nitricName}.example.com`;
                const awsUsEast1 = new aws.Provider("aws-provider-us-east-1", { region: "us-east-1" });
                const sslCertificate = new aws.acm.Certificate(
                    "ssl-cert",
                    {
                        domainName: domain,
                        validationMethod: "DNS",
                    },
                    { provider: awsUsEast1 }
                );
    
                // Create a DNS zone for our custom domain
                const zone = new aws.route53.Zone("dns-zone", {
                    name: domain,
                });
    
                // Create DNS record to prove to ACM that we own the domain
                // Note: This will only work if your domain name is managed with route53
                const sslCertificateValidationDnsRecord = new aws.route53.Record(
                    "ssl-cert-validation-dns-record",
                    {
                        zoneId: zone.zoneId,
                        name: sslCertificate.domainValidationOptions[0].resourceRecordName,
                        type: sslCertificate.domainValidationOptions[0].resourceRecordType,
                        records: [sslCertificate.domainValidationOptions[0].resourceRecordValue],
                        ttl: 10 * 60, // 10 minutes
                    }
                );
    
                const validatedSslCertificate = new aws.acm.CertificateValidation(
                    "ssl-cert-validation",
                    {
                        certificateArn: sslCertificate.arn,
                        validationRecordFqdns: [sslCertificateValidationDnsRecord.fqdn],
                    },
                    { provider: awsUsEast1 }
                );
    
                const apiDomainName = new aws.apigatewayv2.DomainName("api-domain-name", {
                    domainNameConfiguration: {
                        endpointType: 'REGIONAL',
                        securityPolicy: 'TLS_1_2',
                        certificateArn: validatedSslCertificate.certificateArn,
                    }, 
                    domainName: domain,
                });

                // create the DNS record
                const dnsRecord = new aws.route53.Record("api-dns", {
                    zoneId: zone.zoneId,
                    type: "A",
                    name: domain,
                    aliases: [{
                        name: apiDomainName.domainNameConfiguration.targetDomainName,
                        evaluateTargetHealth: false,
                        zoneId: apiDomainName.domainNameConfiguration.hostedZoneId,
                    }]
                });
    
                // create the domain name mapping to the api gateway
                const basePathMapping = new aws.apigatewayv2.ApiMapping('domain-mapping', {
                    apiId: api.apiId,
                    domainName: apiDomainName.domainName,
                    stage: '$default',
                });
            });
        },
    });

    await dnsStack.setAllConfig(currentInfo.config);

    console.log(await dnsStack.preview());
};

run().catch((err) => console.log(err));
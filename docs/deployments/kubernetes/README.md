# Deploying with Kubernetes.

In the [planner-llm-agent] directory, you will find an example of deployment using Yaml
files (with Kustomize). The agent actions are defined in the `llm-agent.yaml` key of
the ConfigMap, mounted at `/etc/planner/llm-agent.yaml` in the container.

The ConfigMap volume is mounted as a directory (`mountPath: /etc/planner`, without
`subPath`): Kubernetes only propagates ConfigMap updates to directory-mounted
volumes, so the agent can hot-reload the actions file and apply a change without a
restart (see the "Agent actions" section of the main README). With a `subPath`
single-file mount, the content stays frozen until the pod is recreated.

To Launch the application in Kubenetes:

```bash
git clone https://github.com/devopsplaybook-io/planner-llm-agent
cd planner-llm-agent/docs/deployments/kubernetes/planner-llm-agent
kubectl kustomize . | kubectl apply -f -
```

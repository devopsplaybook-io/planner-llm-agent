# Deploying with Kubernetes.

In the [planner-llm-agent] directory, you will find an example of deployment using Yaml
files (with Kustomize). The agent actions are defined in the `llm-agent.yaml` key of
the ConfigMap, mounted at `/etc/planner/llm-agent.yaml` in the container.

To Launch the application in Kubenetes:

```bash
git clone https://github.com/devopsplaybook-io/planner-llm-agent
cd planner-llm-agent/docs/deployments/kubernetes/planner-llm-agent
kubectl kustomize . | kubectl apply -f -
```

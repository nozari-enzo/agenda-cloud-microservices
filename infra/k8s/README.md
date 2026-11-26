# Deploy no Kubernetes (k3d)

Os manifests sobem a aplicação com alta disponibilidade:

| Recurso | Para quê |
|---------|----------|
| `Deployment` com 2 réplicas | nenhum micro serviço depende de um único pod |
| `RollingUpdate` (`maxUnavailable: 0`) | deploy sem downtime |
| `readinessProbe` (`/ready`) e `livenessProbe` (`/health`) | tira do balanceamento pods sem banco e reinicia pods travados |
| `HorizontalPodAutoscaler` (2 a 5 pods, CPU 70%) | escala horizontal automática |
| `PodDisruptionBudget` (`minAvailable: 1`) | manutenção de nós nunca derruba todas as réplicas |
| `podAntiAffinity` | espalha as réplicas entre nós |
| `StatefulSet` + PVC | PostgreSQL e RabbitMQ com armazenamento persistente |

## Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [k3d](https://k3d.io), `kubectl` e [Helm](https://helm.sh)

## 1. Criar o cluster (1 server + 2 agents)

```bash
k3d cluster create agenda --agents 2 -p "8081:80@loadbalancer"
```

## 2. Construir e importar as imagens

Na raiz do repositório:

```bash
docker compose build
k3d image import -c agenda \
  agenda/auth-service:1.0.0 agenda/catalog-service:1.0.0 agenda/booking-service:1.0.0 \
  agenda/notification-service:1.0.0 agenda/frontend:1.0.0 agenda/gateway:1.0.0
```

## 3. Aplicar os manifests

```bash
kubectl apply -k infra/k8s
kubectl -n agenda get pods -w
```

A aplicação fica em http://localhost:8081.

## 4. Monitoramento (kube-prometheus-stack + Loki)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
helm install loki grafana/loki-stack -n monitoring --set promtail.enabled=true

kubectl apply -f infra/k8s/monitoring/servicemonitor.yaml
kubectl -n monitoring port-forward svc/monitoring-grafana 3001:80
```

Importe `observability/grafana/dashboards/agenda-overview.json` no Grafana (http://localhost:3001).

## Demonstrações de HA para a apresentação

```bash
# 1. Derrubar um pod: o Kubernetes recria e o outro continua atendendo
kubectl -n agenda delete pod -l app=booking-service --wait=false
kubectl -n agenda get pods -l app=booking-service -w

# 2. Auto scaling: gerar carga e acompanhar o HPA
node scripts/gerar-trafego.mjs --url http://localhost:8081 --minutos 5 --concorrencia 20
kubectl -n agenda get hpa -w

# 3. Rolling update sem downtime
kubectl -n agenda rollout restart deployment/catalog-service
kubectl -n agenda rollout status deployment/catalog-service
```

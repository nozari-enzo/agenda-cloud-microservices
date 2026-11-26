# Guia de uso e de demonstração

Guia para usar a Agenda Fácil, entender o dashboard e montar a apresentação (04/12).

---

## 1. Ligar e desligar

Na pasta do projeto, com o Docker Desktop aberto ("Engine running"):

Na primeira vez, crie o `.env` a partir do `.env.example` e troque as senhas. Ele nunca vai para o GitHub.

| Ação | Comando |
|------|---------|
| Subir tudo (primeira vez ou após mudar código) | `docker compose up -d --build` |
| Pausar (mantém os dados) | `docker compose stop` |
| Voltar de uma pausa | `docker compose start` |
| Ver se está tudo de pé | `docker compose ps` |
| Apagar tudo e começar do zero | `docker compose down -v` e depois `docker compose up -d` |

## 2. Endereços e acessos

| O quê | Endereço | Login |
|-------|----------|-------|
| **Aplicação** | http://localhost:8080 | admin: `ADMIN_EMAIL` / `ADMIN_PASSWORD` do `.env`, ou "Criar conta" para cliente |
| **Grafana** (dashboard) | http://localhost:3000/d/agenda-overview | `GRAFANA_USER` / `GRAFANA_PASSWORD` do `.env` |
| Prometheus | http://localhost:9090 | sem login |
| RabbitMQ | http://localhost:15672 | `RABBITMQ_USER` / `RABBITMQ_PASSWORD` do `.env` |

> Cuidado nos slides e na gravação da demo: não mostre o conteúdo do `.env` na tela.

## 3. Como usar a aplicação

### Como cliente
1. Em http://localhost:8080, clique em **Criar conta** e cadastre nome, e-mail e senha (mínimo 6 caracteres).
2. Na aba **Agendar**, escolha o **serviço**, o **profissional** e a **data**.
3. Aparecem os **horários livres** entre 9h e 18h. Horários ocupados e horários que já passaram não aparecem.
4. Clique num horário e confirme. Aparece o aviso "Agendamento confirmado!".
5. Na aba **Meus agendamentos** ficam todos os seus horários, com o botão **Cancelar**.

### Como administrador (dono do estabelecimento)
1. Clique em **Sair** e entre com o e-mail e a senha de admin definidos no `.env`.
2. **Agenda do dia:** todos os agendamentos de uma data, com nome e e-mail do cliente. O admin também pode cancelar.
3. **Catálogo:** adicionar e remover serviços (nome, duração, preço) e profissionais.
4. **Notificações:** as mensagens que o sistema "enviou" por e-mail: confirmação, cancelamento e lembrete 24h antes.

### Roteiro curto para a demo ao vivo (5 min)
1. Criar conta de cliente → agendar "Coloração" com a Ana amanhã às 10:00.
2. Mostrar que 10:00, 10:30 e 11:00 sumiram dos horários livres, porque a coloração dura 90 minutos.
3. Sair → entrar como admin → **Agenda do dia** (amanhã) mostra o agendamento.
4. Aba **Notificações**: a confirmação e o lembrete, já que é para amanhã, menos de 24h.
5. Abrir o Grafana e mostrar os números subindo.
6. Rodar o gerador de tráfego e mostrar os gráficos reagindo:
   ```bash
   node scripts/gerar-trafego.mjs --minutos 3 --concorrencia 10
   ```
7. Demo de alta disponibilidade (seção 6).

## 4. O que acontece por trás (para explicar)

```
Navegador → Gateway (Nginx) → auth / catalog / booking / notification → PostgreSQL
                                          booking ──evento──► RabbitMQ ──► notification
```

1. **Login:** o `auth-service` confere a senha (guardada com bcrypt) e devolve um **token JWT**. Os outros serviços validam o token sozinhos, sem consultar o auth.
2. **Horários livres:** o `booking-service` pergunta ao `catalog-service` a duração do serviço (chamada HTTP entre micro serviços) e cruza com os agendamentos já existentes.
3. **Agendar:** o `booking-service` grava no banco usando uma trava (*advisory lock*) por profissional. Se duas pessoas clicarem no mesmo horário ao mesmo tempo, mesmo em réplicas diferentes, só uma consegue e a outra recebe "horário ocupado".
4. **Evento:** depois de gravar, o `booking-service` publica `booking.created` no **RabbitMQ** e responde na hora, sem esperar o e-mail.
5. **Notificação:** o `notification-service` consome a fila e "envia o e-mail" (grava e registra no log). Se ele estiver fora do ar, as mensagens esperam na fila.
6. **Lembrete:** a cada minuto o `notification-service` procura agendamentos das próximas 24h e manda lembrete. Com 2 réplicas, a trava `FOR UPDATE SKIP LOCKED` evita lembrete duplicado.

## 5. O dashboard do Grafana, painel por painel

Abra http://localhost:3000/d/agenda-overview. Ele atualiza sozinho a cada 10s. Mude o período no canto superior direito, por exemplo "Last 15 minutes".

### Linha "Visão geral" (os números grandes)
| Painel | O que mostra | O que falar |
|--------|--------------|-------------|
| **Instâncias no ar** | quantas réplicas dos micro serviços estão respondendo. O normal é **8** (4 serviços × 2 réplicas). Fica laranja/vermelho se cair. | "Temos 8 instâncias, nenhum serviço depende de uma só." |
| **Requisições/s** | quantas requisições por segundo o sistema está recebendo agora | carga atual |
| **Taxa de erro 5xx** | % de respostas com erro do servidor. Verde abaixo de 1%, vermelho acima de 5%. | saúde geral |
| **Latência p95** | 95% das requisições respondem em menos que esse tempo | experiência do usuário |
| **Agendamentos criados** | total de agendamentos desde que o serviço subiu | métrica de **negócio** |
| **Notificações enviadas** | total de e-mails (confirmação + cancelamento + lembrete) | |

### Linha "Tráfego e desempenho"
| Painel | O que mostra |
|--------|--------------|
| **Requisições por serviço** | req/s separado por micro serviço. Mostra qual serviço é mais usado (o catalog e o booking costumam liderar). |
| **Latência p95 por serviço** | tempo de resposta de cada serviço. O `auth-service` é naturalmente mais lento (~100–250 ms), porque o bcrypt é lento **de propósito** para proteger as senhas. Bom ponto para comentar. |
| **Respostas por código HTTP** | 200 (ok), 201 (criado), 401 (sem login), 404 (não encontrado), 409 (horário ocupado). O gerador de tráfego força alguns 401 e 404 para aparecerem aqui. |
| **Requisições por réplica** | cada linha é uma réplica, identificada pelo IP do container. Mostra que o **gateway está distribuindo a carga** entre as cópias. |

### Linha "Negócio"
| Painel | O que mostra |
|--------|--------------|
| **Agendamentos e cancelamentos** | criados, cancelados e **conflitos de horário** (tentativas de pegar horário já ocupado) a cada 5 min |
| **Notificações por tipo** | confirmation, cancellation e reminder |

### Linha "Mensageria e infraestrutura"
| Painel | O que mostra |
|--------|--------------|
| **Fila RabbitMQ** | mensagens aguardando e em processamento. Normalmente fica em **0**, porque o notificador consome na hora. Se o notificador cair, a linha sobe. |
| **Atraso evento → notificação** | tempo entre o agendamento ser criado e o e-mail sair (normalmente < 100 ms) |
| **Conexões no PostgreSQL** | quantas conexões abertas o banco tem (vem do postgres-exporter) |
| **Memória por réplica / CPU por réplica** | consumo de recursos de cada instância. É a métrica que o Kubernetes usa para escalar (HPA em 70% de CPU). |

### Linha "Logs"
| Painel | O que mostra |
|--------|--------------|
| **Logs da aplicação (Loki)** | os logs de todos os serviços num lugar só, em JSON. Clique numa linha para ver os campos. No topo do dashboard há o filtro **"Serviço (logs)"** para ver só um serviço. |
| **Logs de erro e alerta por serviço** | quantos logs `warn` e `error` cada serviço gerou por minuto. Os `warn` vêm dos 401/404/409 forçados pelo gerador de tráfego. |

Para buscar logs livremente: **Explore** (menu lateral) → fonte **Loki** → por exemplo `{service="notification-service"} |= "e-mail enviado"`.

### Alertas
No Prometheus (http://localhost:9090/alerts) estão as regras: instância fora do ar, réplicas abaixo de 2, erro 5xx acima de 5%, latência p95 acima de 500 ms, fila acumulando e eventos na dead-letter queue.

## 6. Demonstrações de alta disponibilidade

**a) Uma réplica cai e o sistema continua.** No Grafana, "Instâncias no ar" cai para 7 e depois volta para 8.
```bash
docker stop agenda-booking-service-1
# use a aplicação normalmente: continua funcionando
docker start agenda-booking-service-1
```

**b) O notificador cai e nenhuma mensagem se perde.** Veja a fila em http://localhost:15672 → Queues.
```bash
docker compose stop notification-service
# faça 2 ou 3 agendamentos: a fila "notifications" acumula mensagens
docker compose start notification-service
# a fila esvazia e as notificações aparecem na aba Notificações
```

**c) Escalar na hora.** "Instâncias no ar" vai para 10.
```bash
docker compose up -d --scale booking-service=4 --no-recreate
```

No Kubernetes (k3d), o equivalente automático é o HPA. Veja [infra/k8s/README.md](../infra/k8s/README.md).

## 7. Sugestão de roteiro para os slides (20 min)

1. **Problema** (1 slide): agenda por WhatsApp/caderno, conflitos de horário, faltas.
2. **Solução e funcionalidades** (1–2): cliente agenda sozinho, admin gerencia, notificações automáticas.
3. **RACI** (1): [docs/RACI.md](RACI.md).
4. **Arquitetura** (2): o diagrama do README, as camadas e a stack (Node, PostgreSQL, RabbitMQ, Nginx, Docker, Kubernetes).
5. **Micro serviços e fluxos** (2): o que cada serviço faz; comunicação síncrona (HTTP) e assíncrona (fila).
6. **Alta disponibilidade e escalabilidade** (2): réplicas, health checks, HPA, PDB, rolling update, fila com DLQ, trava contra agendamento duplicado.
7. **Monitoramento e observabilidade** (2–3): Prometheus, Loki, Grafana, alertas, com prints do dashboard.
8. **Demo ao vivo ou gravada** (5–7 min): roteiro da seção 3 + uma demo da seção 6.
9. **Conclusão** (1).

Os prints do dashboard ficam em `docs/evidencias/`. Tire-os depois de rodar o gerador de tráfego por uns 3–5 minutos.

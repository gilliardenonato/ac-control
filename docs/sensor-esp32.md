# Sensor externo (ESP32)

Controle, histórico, energia e automações que **desligam** por temperatura funcionam só com o sensor do próprio ar-condicionado. O sensor externo é um complemento, e é obrigatório só para **ligar** o ar por temperatura: o sensor do split lê o ar junto ao aparelho e atualiza devagar (a LG pode demorar vários minutos), enquanto um ESP32 com DHT na altura da cama ou do sofá dá a temperatura que você sente, a cada 30 segundos.

## O que só funciona com o ESP32

- **Ligar o ar por temperatura.** O sensor do split não atualiza a temperatura enquanto o aparelho está desligado, então uma regra "quando passar de 27 °C, ligar" só dispara se a temperatura vier do ESP32. Desligar por temperatura funciona com os dois.
- **Umidade da sala.** Este modelo de ar-condicionado não tem sensor de umidade.
- **Temperatura da sala em tempo real.** No painel e no gráfico, a curva do ESP32 se atualiza a cada 30 s; a do aparelho, a cada poucos minutos e só com ele ligado.

O repositório **não** inclui o firmware do ESP32; só o contrato abaixo.

## O que o ESP32 precisa servir

Um endpoint HTTP `GET` na rede local que responda JSON:

```json
{ "status": "ok", "temperature_c": 28.7, "humidity_pct": 61 }
```

| Campo | Obrigatório | Observação |
|---|---|---|
| `temperature_c` | um dos dois | °C, entre -40 e 85. Também aceita `temperature`, `temp`, `t` |
| `humidity_pct` | um dos dois | %, entre 0 e 100. Também aceita `humidity`, `hum`, `h` |
| `status` | não | se existir e for diferente de `ok`, a leitura é recusada |

Valores fora da faixa física viram erro e não entram no histórico.

## Cadastrar

1. Abra **Configurações → Sensores externos**.
2. Informe o nome e a URL (ex.: `http://192.168.1.14/sensor`).
3. Clique em **Testar URL**: o app consulta uma vez e mostra a leitura.
4. Clique em **Cadastrar sensor**.

## Como é usado

- O app consulta cada sensor a cada 30 s e guarda uma leitura por minuto. O sensor aparece como *online* enquanto a última leitura tiver menos de 5 minutos.
- Na **Visão geral**, o número grande passa a ser a temperatura do sensor, a umidade aparece ao lado e o gráfico ganha uma segunda curva.
- Em **Automações**, o formulário ganha o campo **Fonte da temperatura**: "Sensor do próprio ar-condicionado" ou o sensor cadastrado. A regra então decide pela temperatura do ESP32. Se o sensor parar de responder, a condição de temperatura fica desconhecida e nenhuma regra nova dispara.
- As leituras são mantidas por 90 dias.

## Segurança

A URL é consultada com timeout de 5 s, sem seguir redirecionamentos e com resposta limitada a 8 KB. Use um endereço da sua rede local; o AC Control só lê, nunca envia nada ao sensor.

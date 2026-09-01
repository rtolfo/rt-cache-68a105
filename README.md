# APSKY EPG

Gerador de XMLTV para o AppSKY.

Fonte principal:
- Meuguia.tv para horario, titulo e categoria.

Fallback:
- BrazilTVEPG Claro para sinopse e classificacao quando houver correspondencia segura.

Depois de publicar este repositorio no GitHub, a URL do EPG sera:

```text
https://raw.githubusercontent.com/SEU-USUARIO/apsky-epg/main/output/apsky-epg.xml
```

O GitHub Actions roda automaticamente cinco vezes por dia e tambem pode ser iniciado manualmente pela aba Actions.

## Teste local

```bash
python3 scripts/generate_epg.py
```

O arquivo gerado fica em:

```text
output/apsky-epg.xml
```

## Ajustar canais

Edite:

```text
config/channels.json
```

Cada item liga o nome usado no AppSKY ao codigo do canal no Meuguia.

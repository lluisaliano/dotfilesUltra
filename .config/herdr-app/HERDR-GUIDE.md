# Guía de Herdr

Cómo funciona Herdr, qué hay en esta configuración y qué conviene saber para no romperla.

## Dos programas

Herdr son dos programas que trabajan juntos:

| | **herdr-core** (`hc`) | **herdr-app** |
|---|---|---|
| Qué es | El servidor que ejecuta los terminales y los agentes | La ventana: espacios, pestañas, paneles |
| Vive | En segundo plano, aunque cierres la ventana | Solo mientras la ventana está abierta |
| Config | `~/.config/herdr-core/config.toml` | `~/.config/herdr-app` (este repo) |
| Se maneja con | `hc ...` | `herdr-app ...` y estos archivos |

La idea clave: **la ventana solo enseña; los terminales viven en el core.** Si cierras Herdr, o se cuelga, o se actualiza, tus terminales y agentes siguen corriendo. Al volver a abrir, los encuentras como estaban.

### herdr-core (`hc`)

Ejecuta cada terminal y cada agente (Claude Code, Codex...). Cosas útiles:

```sh
hc ls                 # terminales vivos (t1, t7...)
hc read t7            # lo que hay en la pantalla de t7
hc send t7 "texto"    # escribir en t7 y pulsar Enter
hc wait t7            # esperar a que un agente termine
hc attach t7          # meterte en t7 desde otro terminal (ctrl+\ para salir)
hc run -- npm test    # ejecutar algo en un terminal nuevo
hc machine ls         # otras máquinas conectadas (minipc)
hc exec --on minipc uptime   # ejecutar un comando en otra máquina
hc server status      # estado del core
```

- **Agentes**: son terminales cuyo programa informa de su estado: `working`, `blocked` (te necesita), `done` (terminó sin que miraras) o `idle`.
- **Sub-agentes**: si un agente lanza otro con `hc run`, el core apunta quién es el padre; salen bajo él en la lista de agentes.
- **Otras máquinas**: con `hc machine add` (por ssh) el core de aquí habla con el de allí. Un espacio puede vivir en otra máquina (minipc) y sus terminales corren allí.
- **Si el core se cae** (reinicio, logout), cada terminal "kept" vuelve como una shell nueva en su última carpeta. El comando original no se repite.

### herdr-app

La ventana. Organiza lo que corre en el core:

- **Espacio**: un sitio de trabajo, normalmente un repo, en una máquina. Se llama como la carpeta de su primer terminal hasta que le pones nombre.
- **Pestaña**: un trabajo dentro del espacio, con sus terminales partidos a derecha y abajo.
- **Panel (pane)**: un terminal en pantalla, o un mod (un visor de archivos, por ejemplo).

Comandos útiles:

```sh
herdr-app status      # qué se ve y si hay errores (¡mira aquí primero!)
herdr-app ls          # espacios, pestañas y terminales
herdr-app do tab.new --name "fix login"    # cualquier comando de la app
herdr-app commands    # la lista de todos los comandos
herdr-app shot        # captura de la ventana
herdr-app check mods/<mod>   # comprobar un mod
```

## Todo es archivos

Esta carpeta **es** la interfaz. La ventana se redibuja en un segundo cuando cambias algo aquí:

| Archivo | Qué decide |
|---|---|
| `layouts/<nombre>.json` | La ventana entera: barras, paneles, colores, tema |
| `keys.json` | Qué hace cada tecla |
| `settings.json` | Lo tuyo: zoom, sonidos, fuentes, tema, modo oscuro |
| `mods/<nombre>/` | Paneles hechos en JavaScript (barra lateral, pestañas, Linear...) |
| `themes/` | Temas de color (`warp-one-dark` es el tuyo) |

Si un archivo tiene un error, Herdr se queda con la última versión buena y escribe el motivo en `<nombre>.error` y en `herdr-app status`.

**Tecla de emergencia**: `ctrl+alt+shift+escape` siempre funciona. Aparta el layout y `keys.json` actuales y vuelve al layout por defecto. Sirve si rompes algo y no puedes ni moverte.

## Lo que Herdr reescribe (no lo edites)

- **Sus layouts y mods de serie** (`main`, `spaces`, `agents`, `tabs`, `workspace-chrome`...): se reponen en cada arranque. Si editas uno, Herdr lo mueve a `<nombre>-edited` y restaura el suyo. Para cambiarlos, **clónalos**: `herdr-app do mod.clone '{"name":"tabs","as":"mis-tabs"}'`.
- **`frame/`** (Settings, bienvenida, paleta), **`AGENTS.md`**, **`herdr.d.ts`**, **`gpui-kit.d.ts`**, **`icons/`**: se reescriben siempre.

Por eso no están en este repo (ver `.gitignore`).

## Esta configuración (luxor-layout)

### Barra lateral (izquierda)
- **Luxor** arriba (`lluis-brand`), **Spaces** agrupados (`space-groups`), **Agents** (`space-groups-agents`).
- Pie: **Settings** y **Add machine** (`lluis-chrome`).

### Barra de pestañas (arriba, `zed-tabs`)
- Pestañas y **+** justo a su derecha: nueva terminal, agentes, **Open with Zed** (`herdr-open-with-zed`), espacios y worktrees.
- A la derecha: **Tasks · Zed · Files · Changes · Graph · Review · View PRs · Linear**. Se pueden ocultar en Settings → Toolbar.

| Botón | Qué hace |
|---|---|
| Tasks | Comandos con nombre por espacio (Build, Format...). Se ejecutan en un terminal debajo (`lluis-tasks`) |
| Zed | Abre el repo del espacio en Zed (también **Alt+E**) |
| Files | Árbol de archivos; al hacer clic se abre en una pestaña con colores, o en tu editor |
| Changes | Git para hacer commits: stage, mensaje, commit, ramas, push/pull |
| Graph | Gráfico de commits |
| Review | Diff completo para revisar, comentar líneas y mandar los comentarios a un agente |
| View PRs | PRs abiertas del repo (con `gh`), y lanzar una review con un agente |
| Linear | Issues de Linear (con la CLI `linear`), cambiar estado y lanzar un agente sobre un issue |

### Barra de estado (abajo)
Resumen de agentes, cuotas de Claude y Codex (`zed-quota`) y atajos.

### Settings (`lluis-settings`)
Copia de la pantalla de Settings de Herdr con tres secciones más:
- **Editor**: editor por defecto y si los archivos de Files se abren en Herdr o en el editor.
- **Toolbar**: mostrar u ocultar los botones de arriba a la derecha.
- **Mods**: abre el Mod Manager.

Al ser una copia, no recibe las mejoras de futuras versiones de Herdr. Si falta algo nuevo, se vuelve a copiar `frame/settings/main.js` y se le añaden las tres secciones.

### Teclas propias
| Tecla | Acción |
|---|---|
| Ctrl+, | Settings |
| Alt+E | Abrir el espacio en Zed |
| Alt+Q | Servers: CPU, memoria, disco y contenedores Docker de cada máquina |
| Alt+Shift+; | Paleta de comandos |
| Ctrl+Shift+L | Cambiar de layout |
| Ctrl+Shift+B | Mostrar u ocultar la barra lateral |

El resto está en `keys.json`.

## Mods de otras personas

Algunos mods vienen de repos ajenos y **llevan cambios locales**. Si los reinstalas desde su repo, los pierdes:

| Mod | Origen | Cambios locales |
|---|---|---|
| `linear` | angaziz/herdr-linear | Linux (`wl-copy`, `xdg-open`, `paru`), gris más oscuro |
| `servers` | obrunogonzaga/herdr-mods | Muestra todos los contenedores |
| `pr-review-assist` | miriarte33/herdr-pr-review-assist | — |
| `herdr-open-with-zed` | atleugim/herdr-open-with-zed | — |

Para añadir uno nuevo, se le dice a un agente: *"Read ~/.config/herdr-app/AGENTS.md, then add this mod: <url>"*. Antes de instalar debe avisar si el mod usa la red, ejecuta programas o lee archivos fuera de su carpeta.

## Qué debes saber

1. **Cerrar la ventana no mata nada.** Los agentes siguen en el core. Para pararlos: cerrar su panel o `hc kill t7`.
2. **Si algo se ve raro, mira `herdr-app status`.** Ahí salen los errores de archivos y mods.
3. **No edites los mods ni layouts de serie**: clónalos.
4. **Al instalar un mod con `"place"` distinto de `"none"` en su `mod.json`**, Herdr lo acopla solo en tu layout la primera vez que lo ve. Si aparece un panel donde no querías, quítalo del layout.
5. **Los mods guardan estado compartido** (tareas, filtros, preferencias) en `shared.json`, que no está en el repo: es personal.
6. **Varios agentes editando estos archivos a la vez** se pisan. Mejor uno cada vez.
7. **Cambios de esta carpeta**: `git add -A && git commit -m "..." && git push`.

## Instalar en otra máquina

```sh
git clone https://github.com/lluisaliano/herdr-luxor.git ~/.config/herdr-app
herdr-app do layout.switch '{"name":"luxor-layout"}'
```

Programas que usan algunos mods: `zeditor` o `zed`, `gh` (con sesión), `linear` (AUR `linear-cli-schpet-bin`, con `linear auth login`), `docker`, `wl-copy`, `xdg-open`.

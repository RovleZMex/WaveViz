# WaveViz

Visualizador de música estilo osciloscopio. Le das un archivo de audio (MP3, WAV, FLAC, OGG, M4A…) y dibuja la forma de onda en tiempo real con un haz de fósforo simulado: persistencia, resplandor y brillo según la velocidad del haz, como en un osciloscopio analógico.

Funciona en Windows y macOS (app de escritorio con Electron).

## Usar

Necesitas [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
```

```bash
npm start
```

Arrastra una canción a la ventana o pulsa **Abrir audio**.

Para generar el ejecutable (`dist/`): `npm run dist:win` en Windows (un `.exe` portable) o `npm run dist:mac` en macOS (un `.dmg`). Cada push a GitHub también los compila; se descargan desde la pestaña **Actions** del repositorio. Los binarios no están firmados por un desarrollador registrado. En Windows: "Más información → Ejecutar de todas formas". En macOS, si al abrirla dice que está dañada o que no se puede verificar, arrástrala a Aplicaciones y ejecuta:

```bash
xattr -cr /Applications/WaveViz.app
```

## Modos y presets

| Modo | Qué dibuja |
| --- | --- |
| Osciloscopio XY | Canal izquierdo en X y derecho en Y (figuras de Lissajous). También Mid/Side y "retardo", que enfrenta la señal con una copia retrasada de sí misma y saca patrones incluso de audio mono. |
| Onda | La forma de onda clásica, con trigger para que se quede quieta. |
| Radial | La onda enrollada en un anillo. |

Presets incluidos: Osciloscopio XY, Retrato de fase, Mandala, tres de bandas (onda, XY y anillos), Onda clásica y Anillo. Todo es ajustable desde el panel (color, ciclo de color, grosor, persistencia, resplandor, ganancia, zoom, rotación, giro, simetría, espejo, fondo, retícula) y puedes guardar tus propios presets, exportarlos a JSON e importarlos.

### Bandas de frecuencia

Con **Separar graves / medios / agudos** el audio se filtra en tres bandas y cada una se dibuja como su propio trazo, con su color y su nivel (nivel 0 oculta la banda). Se pueden mostrar separadas (filas en Onda, anillos concéntricos en Radial, lado a lado en XY) o superpuestas, y los cortes de frecuencia son ajustables. **Nivel automático** agranda las señales débiles, como los agudos, para que siempre se vean.

### Exportar video

**Exportar video** guarda la canción completa con los ajustes actuales en un MP4 con audio (720p a 4K, vertical o cuadrado, 30 o 60 fps). Se renderiza cuadro por cuadro fuera de tiempo real, así que no pierde cuadros aunque el equipo sea lento. El archivo se arma en memoria: para canciones largas en 4K hace falta bastante RAM.

Atajos: `Espacio` play/pausa · `F` pantalla completa · `H` ocultar controles · `←` `→` saltar 5 s.

## Código

- `main.js` — ventana de Electron.
- `src/audio.js` — decodificación y reproducción; entrega las muestras exactas que están sonando.
- `src/modes.js` — convierte muestras en segmentos de línea para cada modo.
- `src/renderer.js` — render WebGL2 del haz (acumulación en punto flotante, decaimiento, glow, tone mapping).
- `src/export.js` — exportación a MP4 (WebCodecs + `src/vendor/mp4-muxer.mjs`, licencia MIT).
- `src/presets.js` — ajustes por defecto, presets incluidos y el esquema que genera el panel.
- `src/ui.js`, `src/app.js` — panel de controles, transporte y bucle de render.

Para añadir un modo: una función nueva en `modes.js`, su opción en el `SCHEMA` de `presets.js` y su brillo en `ENERGY` (`app.js`).

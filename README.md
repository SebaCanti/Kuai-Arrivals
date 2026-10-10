# Kuai Tracking

PWA para seguir naves de Chile a China (Shanghai, Tianjin, Hong Kong, Nansha, Shenzhen): días restantes, barra de progreso zarpe → ETA, retraso contra el ETA original, alerta de llegada y aviso cuando una nave lleva días sin datos.

## Cómo funciona

- **App** (`index.html`, `js/`, `css/`, `sw.js`): HTML/JS sin build. La lista de naves, BL y fechas manuales se guardan en `localStorage` (usa Export/Import en Settings para pasarla a otro equipo).
- **Datos** (`data/vessels.json`): los genera todos los días a las 6:00 (hora de Chile) el workflow `.github/workflows/update-and-deploy.yml`, que escucha AISStream.io unos minutos y guarda las naves de la ruta Chile → China (destino AIS a un puerto chino o chileno, o vistas en la costa chilena). Después publica el sitio en GitHub Pages.
- **Siempre seguir una nave**: agrega su nombre, IMO o MMSI a `data/watchlist.json`.

## Puesta en marcha

1. Repo → Settings → Secrets and variables → Actions → New secret: `AISSTREAM_API_KEY`.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Actions → *AIS update & deploy* → Run workflow (primera carga de datos).

## Desarrollo

```
npm test                       # pruebas de la lógica y de un viaje simulado
python3 -m http.server 8000    # abrir http://localhost:8000
AISSTREAM_API_KEY=... FORCE=1 LISTEN_MINUTES=5 npm run update
```

## Límites de los datos AIS

El ETA y el destino los escribe la tripulación en el equipo AIS, y AISStream solo recibe señales cerca de la costa (antenas terrestres), así que en medio del Pacífico una nave puede pasar días sin actualizarse. La fecha de zarpe es estimada (última vez vista en la costa chilena) y se puede corregir a mano.

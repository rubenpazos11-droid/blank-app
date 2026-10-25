# El Machaca — demostración navegable

Esta rama contiene una vista pública separada para poder revisar la interfaz sin acceder al servidor privado.

La demo reutiliza las pantallas reales de la aplicación Next.js. Un adaptador de navegador sustituye la API por datos ficticios en memoria. Se pueden recorrer clientes, trabajos, revisión, agenda, asistente y ejemplos de documentos. Todo se reinicia al recargar. No contiene SQLite, cookies, claves, información personal real ni servicios de pago.

`index.html`, `styles.css` y `bundle.js` forman la demo estática. Esta rama no sustituye al proyecto Next.js/SQLite de desarrollo ni constituye un despliegue de producción.

## Capturas reales

![Vista de escritorio](assets/desktop.png)

![Vista móvil](assets/mobile.png)

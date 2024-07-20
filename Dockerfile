# Usamos una imagen base de Node.js
FROM node:18

# Establecemos el directorio de trabajo en /app
WORKDIR /app

# Copiamos el package.json y el package-lock.json
COPY package*.json ./

# Instalamos las dependencias
RUN npm install

# Copiamos el resto de los archivos de la aplicación
COPY . .

# Exponemos el puerto 3000 (o cualquier puerto que uses en tu aplicación)
EXPOSE 3000

# Comando para correr la aplicación
CMD ["node", "index.js"]

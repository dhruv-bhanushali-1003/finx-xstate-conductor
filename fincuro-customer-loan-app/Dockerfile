FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 9000

ENV PORT=9000
ENV HOST=0.0.0.0

CMD ["npm", "start"]
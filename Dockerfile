# Use official Node.js image
FROM node:18

# Enable Corepack to use Yarn 4
RUN corepack enable

# Set working directory
WORKDIR /usr/src/app

# Copy Yarn config files first (important!)
COPY .yarn .yarn
COPY .yarnrc.yml ./
COPY package.json yarn.lock ./

# Activate Yarn 4
RUN corepack prepare yarn@4.1.0 --activate

# Install dependencies
RUN yarn install --immutable

# Copy rest of app
COPY . .

# Build the app
RUN yarn build

# Expose port
EXPOSE 3001

# Start the app
CMD ["yarn", "start"]

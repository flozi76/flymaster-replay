# Stage 1: Use nginx to serve the static app
FROM nginx:1.27-alpine

# Remove the default nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy the application source files into the nginx web root
COPY . /usr/share/nginx/html/

# Copy the custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# nginx runs in the foreground by default in the official image
CMD ["nginx", "-g", "daemon off;"]
